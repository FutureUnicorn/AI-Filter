import * as Sentry from "@sentry/node";
import { loadMonitoringConfig, type EnvironmentSource, type MonitoringConfig } from "@signal-audit/config";
import type { InferenceBudgetConfig, InferenceBudgetStatus, InferenceUsageSnapshot } from "@signal-audit/domain";
import { describeError, logStructured, type SafeErrorDiagnostic } from "@signal-audit/security";
import type { Event, Span } from "@sentry/node";

type SentrySpanJson = ReturnType<typeof Sentry.spanToJSON>;

export type WorkerOperation = "worker.startup" | "worker.job" | "inference.token_budget";

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
        : { error_name: diagnostic.errorName, error_code: diagnostic.errorCode })
    },
    ...(diagnostic === undefined
      ? {}
      : { fingerprint: [safeOperation, diagnostic.errorName, diagnostic.errorCode] }),
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
