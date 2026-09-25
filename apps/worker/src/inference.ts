import {
  getInferenceUsage,
  reserveInferenceBudget,
  settleInferenceReservation
} from "@signal-audit/db";
import { AiCallNotStartedError, InferenceKillSwitchEngagedError } from "@signal-audit/ai";
import {
  checkInferenceBudget,
  type AiAdapter,
  type AiCallUsage,
  type AiStructuredCallInput,
  type AiStructuredCallResult,
  type InferenceBudgetConfig
} from "@signal-audit/domain";

import {
  buildInferenceBudgetTelemetry,
  recordInferenceBudgetTelemetry
} from "./observability.ts";

export interface BudgetedInferenceInput {
  readonly organizationId: string;
  readonly model: string;
  readonly periodStart: string;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly budget: InferenceBudgetConfig;
  readonly call: AiStructuredCallInput;
}

export class InferenceBudgetCappedError extends Error {
  readonly tokensUsedThisPeriod: number;
  readonly maxTokensPerPeriod: number;

  constructor(tokensUsedThisPeriod: number, maxTokensPerPeriod: number) {
    super("Inference token budget is capped");
    this.name = "InferenceBudgetCappedError";
    this.tokensUsedThisPeriod = tokensUsedThisPeriod;
    this.maxTokensPerPeriod = maxTokensPerPeriod;
  }
}

function usageFromFailure(error: unknown): AiCallUsage | undefined {
  if (typeof error !== "object" || error === null || !("metadata" in error)) {
    return undefined;
  }
  const metadata = error.metadata;
  if (typeof metadata !== "object" || metadata === null || !("usage" in metadata)) {
    return undefined;
  }
  const usage = metadata.usage;
  if (
    typeof usage !== "object" ||
    usage === null ||
    !("inputTokens" in usage) ||
    !("outputTokens" in usage) ||
    typeof usage.inputTokens !== "number" ||
    typeof usage.outputTokens !== "number"
  ) {
    return undefined;
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

function providerStatusFromFailure(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = error.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/**
 * Every granted reservation receives one durable settlement.
 *
 * A typed pre-provider rejection and an HTTP error response are known not to
 * have produced a model result, so both release the estimate. A response that
 * carries usage is settled exactly. Everything else (notably a client-side
 * timeout or connection loss after dispatch) keeps the conservative estimate
 * because provider billing is genuinely unknown.
 */
function usageToSettleAfterFailure(
  error: unknown,
  input: BudgetedInferenceInput
): AiCallUsage {
  const reported = usageFromFailure(error);
  if (reported !== undefined) {
    return reported;
  }
  const status = providerStatusFromFailure(error);
  if (
    error instanceof InferenceKillSwitchEngagedError ||
    error instanceof AiCallNotStartedError ||
    (status !== undefined && status >= 400 && status <= 599)
  ) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  return {
    inputTokens: input.estimatedInputTokens,
    outputTokens: input.estimatedOutputTokens
  };
}

async function publishCommittedBudgetState(
  databaseUrl: string,
  schema: string,
  input: BudgetedInferenceInput
): Promise<void> {
  try {
    const usage = await getInferenceUsage(databaseUrl, schema, {
      organizationId: input.organizationId,
      model: input.model,
      periodStart: input.periodStart
    });
    const snapshot = {
      tokensUsedThisPeriod: usage.inputTokens + usage.outputTokens
    };
    const status = checkInferenceBudget(snapshot, input.budget);
    await recordInferenceBudgetTelemetry(
      buildInferenceBudgetTelemetry(status, snapshot, input.budget)
    );
  } catch {
    // Reading or publishing monitoring state must never change inference
    // success, retry, or settlement semantics.
  }
}

/**
 * The worker's single production boundary for a metered provider call.
 *
 * AF-102 will deliver durable jobs to this function. Keeping queue mechanics
 * outside this boundary lets AF-67 guarantee that every real provider call is
 * reserved, settled, and observed without inventing a queue implementation.
 */
export async function executeBudgetedInference(
  adapter: AiAdapter,
  databaseUrl: string,
  schema: string,
  input: BudgetedInferenceInput
): Promise<AiStructuredCallResult> {
  // Validate both values before a reservation mutates the ledger. The DB
  // boundary independently validates the integer cap and token estimates.
  checkInferenceBudget({ tokensUsedThisPeriod: 0 }, input.budget);

  const reservation = await reserveInferenceBudget(databaseUrl, schema, {
    organizationId: input.organizationId,
    model: input.model,
    periodStart: input.periodStart,
    inputTokens: input.estimatedInputTokens,
    outputTokens: input.estimatedOutputTokens,
    maxTotalTokens: input.budget.maxTokensPerPeriod
  });

  if (reservation.outcome === "cap_exceeded") {
    const snapshot = { tokensUsedThisPeriod: reservation.totalTokensBefore };
    const status = {
      outcome: "capped" as const,
      tokensUsedThisPeriod: reservation.totalTokensBefore,
      maxTokensPerPeriod: input.budget.maxTokensPerPeriod
    };
    await recordInferenceBudgetTelemetry(
      buildInferenceBudgetTelemetry(status, snapshot, input.budget)
    );
    throw new InferenceBudgetCappedError(
      reservation.totalTokensBefore,
      input.budget.maxTokensPerPeriod
    );
  }

  let result: AiStructuredCallResult;
  try {
    result = await adapter.runStructuredCall(input.call);
  } catch (error) {
    const usage = usageToSettleAfterFailure(error, input);
    await settleInferenceReservation(databaseUrl, schema, {
      reservationId: reservation.reservationId,
      actualInputTokens: usage.inputTokens,
      actualOutputTokens: usage.outputTokens
    });
    await publishCommittedBudgetState(databaseUrl, schema, input);
    throw error;
  }

  await settleInferenceReservation(databaseUrl, schema, {
    reservationId: reservation.reservationId,
    actualInputTokens: result.metadata.usage.inputTokens,
    actualOutputTokens: result.metadata.usage.outputTokens
  });
  await publishCommittedBudgetState(databaseUrl, schema, input);
  return result;
}
