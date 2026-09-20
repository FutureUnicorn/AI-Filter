import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  InferenceBudgetCappedError,
  executeBudgetedInference
} from "../../apps/worker/src/inference.ts";
import {
  setWorkerTelemetryAdapterForTesting
} from "../../apps/worker/src/observability.ts";
import {
  getInferenceUsage,
  seedOrganizationMembership
} from "../../packages/db/src/index.ts";
import type {
  AiAdapter,
  AiStructuredCallInput
} from "../../packages/domain/src/index.ts";

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

function requireDatabase(): string {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set. See README.md.");
  }
  return DATABASE_URL;
}

const call: AiStructuredCallInput = {
  promptVersion: "af67-regression-v1",
  schemaVersion: "1.0.0",
  schemaName: "af67_budget_probe",
  jsonSchema: { type: "object", additionalProperties: false },
  systemPrompt: "synthetic private system prompt",
  userPrompt: "synthetic candidate document text"
};

function fakeAdapter(model: string, onCall: () => void): AiAdapter {
  return {
    async runStructuredCall(input) {
      onCall();
      assert.equal(input, call);
      return {
        output: { items: [] },
        metadata: {
          provider: "openai",
          model,
          resolvedModel: `${model}-synthetic-revision`,
          promptVersion: input.promptVersion,
          schemaVersion: input.schemaVersion,
          schemaName: input.schemaName,
          usage: { inputTokens: 720, outputTokens: 90 }
        }
      };
    }
  };
}

test("the production inference boundary settles real usage and emits detector-compatible budget telemetry", async (t) => {
  const databaseUrl = requireDatabase();
  const organizationId = randomUUID();
  const model = `af67-budget-${randomUUID()}`;
  const periodStart = "2026-09-01";
  await seedOrganizationMembership(databaseUrl, "public", {
    organizationId,
    organizationName: "AF-67 Synthetic Budget Probe",
    email: `af67-${organizationId}@example.test`,
    displayName: "AF-67 Synthetic Operator",
    role: "owner"
  });

  const spans: Array<Record<string, unknown>> = [];
  setWorkerTelemetryAdapterForTesting({
    captureException() {
      return undefined;
    },
    startSpan(options, callback) {
      spans.push(options);
      return callback({
        setStatus() {
          return undefined;
        },
        setAttributes() {
          return undefined;
        }
      });
    }
  });
  t.after(() => setWorkerTelemetryAdapterForTesting(undefined));

  let providerCalls = 0;
  const adapter = fakeAdapter(model, () => {
    providerCalls += 1;
  });
  const input = {
    organizationId,
    model,
    periodStart,
    estimatedInputTokens: 800,
    estimatedOutputTokens: 100,
    budget: { maxTokensPerPeriod: 1_000, alertThresholdRatio: 0.8 },
    call
  } as const;

  const result = await executeBudgetedInference(
    adapter,
    databaseUrl,
    "public",
    input
  );
  assert.deepEqual(result.output, { items: [] });
  assert.equal(providerCalls, 1);
  assert.deepEqual(
    await getInferenceUsage(databaseUrl, "public", {
      organizationId,
      model,
      periodStart
    }),
    { inputTokens: 720, outputTokens: 90 },
    "settlement must replace the 900-token estimate with the provider's 810-token usage"
  );

  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.name, "inference.token_budget");
  assert.equal(spans[0]?.op, "monitor.budget");
  assert.deepEqual(spans[0]?.attributes, {
    "service.name": "worker",
    "monitor.operation": "inference.token_budget",
    "monitor.budget.status": "warning",
    "monitor.budget.utilization": 0.81,
    "monitor.tokens.used": 810,
    "monitor.tokens.cap": 1_000
  });
  assert.doesNotMatch(
    JSON.stringify(spans),
    /organizationId|candidate|prompt|document|af67-budget-/iu,
    "detector telemetry must not include tenant, model, prompt, or candidate context"
  );

  await assert.rejects(
    () => executeBudgetedInference(
      adapter,
      databaseUrl,
      "public",
      {
        ...input,
        estimatedInputTokens: 190,
        estimatedOutputTokens: 10
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof InferenceBudgetCappedError);
      assert.equal(error.tokensUsedThisPeriod, 810);
      assert.equal(error.maxTokensPerPeriod, 1_000);
      return true;
    }
  );
  assert.equal(providerCalls, 1, "a denied reservation must never call the provider");
  assert.equal(spans.length, 2);
  assert.equal(
    (spans[1]?.attributes as Record<string, unknown>)["monitor.budget.status"],
    "capped"
  );
});

test("a telemetry outage cannot change a settled production inference result", async (t) => {
  const databaseUrl = requireDatabase();
  const organizationId = randomUUID();
  const model = `af67-telemetry-outage-${randomUUID()}`;
  const periodStart = "2026-09-01";
  await seedOrganizationMembership(databaseUrl, "public", {
    organizationId,
    organizationName: "AF-67 Synthetic Telemetry Outage Probe",
    email: `af67-outage-${organizationId}@example.test`,
    displayName: "AF-67 Synthetic Operator",
    role: "owner"
  });

  setWorkerTelemetryAdapterForTesting({
    captureException() {
      throw new Error("telemetry unavailable");
    },
    startSpan() {
      throw new Error("telemetry unavailable");
    }
  });
  t.after(() => setWorkerTelemetryAdapterForTesting(undefined));

  const result = await executeBudgetedInference(
    fakeAdapter(model, () => undefined),
    databaseUrl,
    "public",
    {
      organizationId,
      model,
      periodStart,
      estimatedInputTokens: 800,
      estimatedOutputTokens: 100,
      budget: { maxTokensPerPeriod: 2_000, alertThresholdRatio: 0.8 },
      call
    }
  );
  assert.deepEqual(result.output, { items: [] });
  assert.deepEqual(
    await getInferenceUsage(databaseUrl, "public", {
      organizationId,
      model,
      periodStart
    }),
    { inputTokens: 720, outputTokens: 90 }
  );
});
