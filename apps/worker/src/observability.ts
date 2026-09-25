import * as Sentry from "@sentry/node";
import { loadMonitoringConfig, type EnvironmentSource, type MonitoringConfig } from "@signal-audit/config";
import type { InferenceBudgetConfig, InferenceBudgetStatus, InferenceUsageSnapshot } from "@signal-audit/domain";
import { describeError, logStructured, type SafeErrorDiagnostic } from "@signal-audit/security";
import type { Event, Span } from "@sentry/node";

type SentrySpanJson = ReturnType<typeof Sentry.spanToJSON>;

export type WorkerOperation =
  | "worker.startup"
  | "worker.job"
  | "inference.token_budget"
  | "evidence_extraction.queue";

export const WORKER_JOB_FAILURE_CODES = [
  "invalid_job_context",
  "model_output_invalid",
  "provider_usage_missing",
  "provider_transient",
  "provider_permanent",
  "lease_expired_exhausted",
  "unexpected_error"
] as const;
export type WorkerJobFailureCode = (typeof WORKER_JOB_FAILURE_CODES)[number];

const WORKER_JOB_FAILURE_CODE_SET: ReadonlySet<string> = new Set(WORKER_JOB_FAILURE_CODES);

interface SpanHandle {
  setStatus(status: { readonly code: 2; readonly message?: string }): unknown;
  setAttributes(attributes: Record<string, string | number>): unknown;
}

interface WorkerTelemetryAdapter {
  captureException(error: Error, context: { readonly tags: Record<string, string> }): unknown;
  startSpan<T>(
    options: {
      readonly name: string;
      readonly op: string;
      readonly kind: 0;
      readonly forceTransaction: true;
      readonly attributes: Record<string, string | number>;
    },
    callback: (span: SpanHandle) => T | Promise<T>
  ): T | Promise<T>;
}

const sentryAdapter: WorkerTelemetryAdapter = {
  captureException(error, context) {
    return Sentry.captureException(error, context);
  },
  startSpan(options, callback) {
    return Sentry.startSpan(options, callback as (span: Span) => unknown) as ReturnType<typeof callback>;
  }
};
let telemetryAdapter: WorkerTelemetryAdapter = sentryAdapter;

export function setWorkerTelemetryAdapterForTesting(adapter: WorkerTelemetryAdapter | undefined): void {
  telemetryAdapter = adapter ?? sentryAdapter;
}

function safeWorkerError(diagnostic: SafeErrorDiagnostic): Error {
  const sanitized = new Error("Unexpected worker failure");
  sanitized.name = diagnostic.errorName;
  return sanitized;
}

export function sanitizeWorkerEvent<T extends Event>(event: T, config: MonitoringConfig): T {
  const operation = event.tags?.operation;
  const safeOperation: WorkerOperation =
    operation === "worker.startup" || operation === "worker.job" || operation === "inference.token_budget"
      ? operation
      : "worker.job";
  const hasDiagnostic =
    typeof event.tags?.error_name === "string" || typeof event.tags?.error_code === "string";
  const diagnostic = hasDiagnostic
    ? describeError({ name: event.tags?.error_name, code: event.tags?.error_code })
    : undefined;
  const failureCode = event.tags?.failure_code;
  const safeFailureCode =
    typeof failureCode === "string" && WORKER_JOB_FAILURE_CODE_SET.has(failureCode)
      ? (failureCode as WorkerJobFailureCode)
      : undefined;
  const exceptionValues = event.exception?.values?.map(() => ({
    type: diagnostic?.errorName ?? "WorkerOperationError",
    value: "Unexpected worker failure"
  }));
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: config.environment,
    release: config.release,
    transaction: safeOperation,
    tags: {
      service: "worker",
      operation: safeOperation,
      ...(diagnostic === undefined
        ? {}
        : { error_name: diagnostic.errorName, error_code: diagnostic.errorCode }),
      ...(safeFailureCode === undefined ? {} : { failure_code: safeFailureCode })
    },
    ...(diagnostic === undefined
      ? {}
      : {
          fingerprint: [
            safeOperation,
            ...(safeFailureCode === undefined ? [] : [safeFailureCode]),
            diagnostic.errorName,
            diagnostic.errorCode
          ]
        }),
    ...(exceptionValues === undefined ? {} : { exception: { values: exceptionValues } })
  } as unknown as T;
}

export function sanitizeWorkerSpan(span: SentrySpanJson, config: MonitoringConfig): SentrySpanJson {
  const operation = span.data["monitor.operation"];
  const isBudget = operation === "inference.token_budget";
  const status = span.data["monitor.budget.status"];
  const utilization = span.data["monitor.budget.utilization"];
  const tokensUsed = span.data["monitor.tokens.used"];
  const tokenCap = span.data["monitor.tokens.cap"];
  return {
    trace_id: span.trace_id,
    span_id: span.span_id,
    start_timestamp: span.start_timestamp,
    ...(span.timestamp === undefined ? {} : { timestamp: span.timestamp }),
    ...(span.parent_span_id === undefined ? {} : { parent_span_id: span.parent_span_id }),
    ...(span.status === undefined ? {} : { status: span.status }),
    description: isBudget ? "inference.token_budget" : "worker.operation",
    op: isBudget ? "monitor.budget" : "worker",
    data: {
      "service.name": config.service,
      "monitor.operation": isBudget ? "inference.token_budget" : "worker.job",
      ...(status === "ok" || status === "warning" || status === "capped"
        ? { "monitor.budget.status": status }
        : {}),
      ...(typeof utilization === "number" ? { "monitor.budget.utilization": utilization } : {}),
      ...(typeof tokensUsed === "number" ? { "monitor.tokens.used": tokensUsed } : {}),
      ...(typeof tokenCap === "number" ? { "monitor.tokens.cap": tokenCap } : {})
    }
  };
}

export function initializeWorkerTelemetry(source: EnvironmentSource = process.env): MonitoringConfig {
  const config = loadMonitoringConfig(source, "worker");
  if (!config.enabled) {
    return config;
  }
  Sentry.init({
    dsn: config.dsn as string,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: config.tracesSampleRate as number,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0
    },
    includeLocalVariables: false,
    enableLogs: false,
    maxBreadcrumbs: 0,
    initialScope: { tags: { service: "worker" } },
    beforeBreadcrumb: () => null,
    beforeSend: (event) => sanitizeWorkerEvent(event, config),
    beforeSendTransaction: (event) => sanitizeWorkerEvent(event, config),
    beforeSendSpan: (span) => sanitizeWorkerSpan(span, config)
  });
  return config;
}

export function captureWorkerError(error: unknown, operation: "worker.startup" | "worker.job"): void {
  const diagnostic = describeError(error);
  try {
    telemetryAdapter.captureException(safeWorkerError(diagnostic), {
      tags: {
        service: "worker",
        operation,
        error_name: diagnostic.errorName,
        error_code: diagnostic.errorCode
      }
    });
  } catch {
    // Monitoring must never change worker retry/failure behavior.
  }
  try {
    logStructured("error", "worker.operation_failed", {
      action: operation,
      statusCode: 500,
      errorName: diagnostic.errorName,
      errorCode: diagnostic.errorCode
    });
  } catch {
    // A broken telemetry/log sink must not replace worker failure semantics.
  }
}

/** Reports only a durably terminal queue outcome, never a retryable attempt. */
export function captureWorkerJobFailure(error: unknown, failureCode: WorkerJobFailureCode): void {
  const diagnostic = describeError(error);
  try {
    telemetryAdapter.captureException(safeWorkerError(diagnostic), {
      tags: {
        service: "worker",
        operation: "worker.job",
        failure_code: failureCode,
        error_name: diagnostic.errorName,
        error_code: diagnostic.errorCode
      }
    });
  } catch {
    // Monitoring must never change durable job failure behavior.
  }
  try {
    logStructured("error", "worker.job_failed", {
      action: failureCode,
      statusCode: 500,
      errorName: diagnostic.errorName,
      errorCode: diagnostic.errorCode
    });
  } catch {
    // A broken telemetry/log sink must not replace the durable terminal state.
  }
}

export interface InferenceBudgetTelemetry {
  readonly status: "ok" | "warning" | "capped";
  readonly utilization: number;
  readonly tokensUsedThisPeriod: number;
  readonly maxTokensPerPeriod: number;
}

export function buildInferenceBudgetTelemetry(
  status: InferenceBudgetStatus,
  usage: InferenceUsageSnapshot,
  config: InferenceBudgetConfig
): InferenceBudgetTelemetry {
  const utilization = config.maxTokensPerPeriod === 0 ? 1 : usage.tokensUsedThisPeriod / config.maxTokensPerPeriod;
  return {
    status: status.outcome,
    utilization,
    tokensUsedThisPeriod: usage.tokensUsedThisPeriod,
    maxTokensPerPeriod: config.maxTokensPerPeriod
  };
}

/** Called by executeBudgetedInference after the durable budget state is known. */
export async function recordInferenceBudgetTelemetry(value: InferenceBudgetTelemetry): Promise<void> {
  try {
    await telemetryAdapter.startSpan(
      {
        name: "inference.token_budget",
        op: "monitor.budget",
        kind: 0,
        forceTransaction: true,
        attributes: {
          "service.name": "worker",
          "monitor.operation": "inference.token_budget",
          "monitor.budget.status": value.status,
          "monitor.budget.utilization": value.utilization,
          "monitor.tokens.used": value.tokensUsedThisPeriod,
          "monitor.tokens.cap": value.maxTokensPerPeriod
        }
      },
      (span) => {
        span.setAttributes({
          "monitor.budget.utilization": value.utilization,
          "monitor.tokens.used": value.tokensUsedThisPeriod,
          "monitor.tokens.cap": value.maxTokensPerPeriod
        });
      }
    );
  } catch {
    // A monitoring outage cannot block an inference decision or worker job.
  }
}

/**
 * AF-67 queue-age monitoring, over AF-102's durable queue.
 *
 * Published on the heartbeat tick rather than when a job is dequeued.
 * That distinction is the whole point: AF-102's ticket states that
 * dequeue-only telemetry cannot work, because a completely stalled worker
 * emits nothing while the queue grows behind it, and the absence of
 * events is indistinguishable from an empty queue. Emitting on the
 * heartbeat means a backlog is visible even when nothing is being
 * claimed, which is the case the alert exists for.
 *
 * Every value is a count or a duration. No organization, application,
 * candidate, job or document identifier is included, so the queue signal
 * carries nothing that a retention or deletion request could reach.
 */
export interface EvidenceExtractionQueueTelemetry {
  /** now - the oldest ready job's enqueued_at; null when nothing is ready. */
  readonly oldestReadyAgeMs: number | null;
  readonly readyJobs: number;
  readonly runningJobs: number;
  readonly failedJobs: number;
  readonly completedJobs: number;
  readonly totalAttempts: number;
  /** now - most recent heartbeat. Null when no worker has ever reported. */
  readonly heartbeatAgeMs: number | null;
}

export async function recordEvidenceExtractionQueueTelemetry(
  value: EvidenceExtractionQueueTelemetry
): Promise<void> {
  try {
    await telemetryAdapter.startSpan(
      {
        name: "evidence_extraction.queue",
        op: "monitor.queue",
        kind: 0,
        forceTransaction: true,
        attributes: {
          "service.name": "worker",
          "monitor.operation": "evidence_extraction.queue",
          // -1 for "nothing ready": an empty queue reported as zero age
          // would read to a threshold rule as a perfectly fresh backlog.
          "monitor.queue.oldest_ready_age_ms": value.oldestReadyAgeMs ?? -1,
          "monitor.queue.ready": value.readyJobs,
          "monitor.queue.running": value.runningJobs,
          "monitor.queue.failed": value.failedJobs,
          "monitor.queue.completed": value.completedJobs,
          "monitor.queue.attempts": value.totalAttempts,
          // -1, not omitted: a missing attribute and "no worker has ever
          // reported" would otherwise look the same to a no-data rule.
          "monitor.worker.heartbeat_age_ms": value.heartbeatAgeMs ?? -1
        }
      },
      (span) => {
        span.setAttributes({
          "monitor.queue.oldest_ready_age_ms": value.oldestReadyAgeMs ?? -1,
          "monitor.queue.ready": value.readyJobs,
          "monitor.worker.heartbeat_age_ms": value.heartbeatAgeMs ?? -1
        });
        return undefined;
      }
    );
  } catch {
    // Monitoring must never replace a durable queue outcome. A telemetry
    // failure is not a job failure.
  }
}
