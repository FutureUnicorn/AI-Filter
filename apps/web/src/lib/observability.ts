import * as Sentry from "@sentry/nextjs";
import { loadMonitoringConfig, type EnvironmentSource, type MonitoringConfig } from "@signal-audit/config";
import { describeError, logStructured, type SafeErrorDiagnostic } from "@signal-audit/security";
import type { ErrorEvent, Event, Span } from "@sentry/nextjs";

type SentrySpanJson = ReturnType<typeof Sentry.spanToJSON>;

export const WEB_OPERATIONS = [
  "auth.magic_link.request",
  "auth.magic_link.redeem",
  "file.intake.create",
  "file.upload.complete",
  "file.validate",
  "file.extract_text",
  "csv.preview",
  "csv.finalize",
  "application.review_queue",
  "application.evidence",
  "application.evidence.correct",
  "application.decision",
  "role.list",
  "role.create",
  "rubric.get",
  "rubric.save",
  "rubric.publish",
  "file.intake.get",
  "csv.import_status",
  "csv.import_errors",
  // AF-97's entry-point routes. In WEB_OPERATIONS so their spans and events
  // carry a real name rather than collapsing into `web.request`, and
  // deliberately not in the alerts script's narrower MONITORED_OPERATIONS --
  // that p95 alert set is AF-67's to widen, the same position role.* and
  // rubric.* already sit in.
  "organization.list",
  "invite.create",
  "web.request"
] as const;

export type WebOperation = (typeof WEB_OPERATIONS)[number];

const WEB_OPERATION_SET: ReadonlySet<string> = new Set(WEB_OPERATIONS);
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface SpanHandle {
  setStatus(status: { readonly code: 2; readonly message?: string }): unknown;
}

interface TelemetryAdapter {
  captureException(error: Error, context: { readonly tags: Record<string, string>; readonly extra?: Record<string, string> }): unknown;
  getActiveSpan(): SpanHandle | undefined;
  startSpan<T>(
    options: {
      readonly name: string;
      readonly op: string;
      readonly kind: 1;
      readonly forceTransaction: true;
      readonly attributes: Record<string, string>;
    },
    callback: (span: SpanHandle) => T | Promise<T>
  ): T | Promise<T>;
}

const sentryAdapter: TelemetryAdapter = {
  captureException(error, context) {
    return Sentry.captureException(error, context);
  },
  getActiveSpan() {
    return Sentry.getActiveSpan();
  },
  startSpan(options, callback) {
    return Sentry.startSpan(options, callback as (span: Span) => unknown) as ReturnType<typeof callback>;
  }
};

let telemetryAdapter: TelemetryAdapter = sentryAdapter;

/** Test-only seam; production callers must never replace the SDK adapter. */
export function setWebTelemetryAdapterForTesting(adapter: TelemetryAdapter | undefined): void {
  telemetryAdapter = adapter ?? sentryAdapter;
}

function safeOperation(value: unknown, fallback: WebOperation = "web.request"): WebOperation {
  return typeof value === "string" && WEB_OPERATION_SET.has(value) ? (value as WebOperation) : fallback;
}

function safeError(diagnostic: SafeErrorDiagnostic): Error {
  const sanitized = new Error("Unexpected server failure");
  sanitized.name = diagnostic.errorName;
  return sanitized;
}

function safeTraceContext(event: Event): Event["contexts"] {
  const trace = event.contexts?.trace;
  if (trace === undefined) {
    return undefined;
  }
  const traceId = typeof trace.trace_id === "string" && /^[0-9a-f]{32}$/u.test(trace.trace_id) ? trace.trace_id : undefined;
  const spanId = typeof trace.span_id === "string" && /^[0-9a-f]{16}$/u.test(trace.span_id) ? trace.span_id : undefined;
  if (traceId === undefined || spanId === undefined) {
    return undefined;
  }
  return {
    trace: {
      trace_id: traceId,
      span_id: spanId,
      ...(trace.op === "server.operation" || trace.op === "db" || trace.op === "http.client"
        ? { op: trace.op }
        : {}),
      ...(trace.status === undefined ? {} : { status: trace.status })
    }
  };
}

/** Rebuilds an event from a closed safe-field allowlist. */
export function sanitizeTelemetryEvent<T extends Event>(event: T, config: MonitoringConfig): T {
  const operation = safeOperation(event.tags?.operation ?? event.transaction);
  const requestId = event.extra?.request_id;
  const contexts = safeTraceContext(event);
  const hasDiagnostic =
    typeof event.tags?.error_name === "string" || typeof event.tags?.error_code === "string";
  const diagnostic = hasDiagnostic
    ? describeError({ name: event.tags?.error_name, code: event.tags?.error_code })
    : undefined;
  const exceptionValues = event.exception?.values?.map(() => ({
    type: diagnostic?.errorName ?? "ServerOperationError",
    value: "Unexpected server failure"
  }));
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: config.environment,
    release: config.release,
    transaction: operation,
    tags: {
      service: config.service,
      operation,
      ...(diagnostic === undefined
        ? {}
        : { error_name: diagnostic.errorName, error_code: diagnostic.errorCode })
    },
    ...(diagnostic === undefined
      ? {}
      : { fingerprint: [operation, diagnostic.errorName, diagnostic.errorCode] }),
    ...(typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId)
      ? { extra: { request_id: requestId } }
      : {}),
    ...(contexts === undefined ? {} : { contexts }),
    ...(exceptionValues === undefined ? {} : { exception: { values: exceptionValues } })
  } as unknown as T;
}

function normalizedSpanName(span: SentrySpanJson, service: "web"): { readonly name: string; readonly op: string } {
  const operation = safeOperation(span.data["monitor.operation"] ?? span.description);
  if (operation !== "web.request") {
    return { name: operation, op: "server.operation" };
  }
  const originalOp = span.op?.toLowerCase() ?? "";
  if (originalOp.includes("db") || originalOp.includes("postgres")) {
    return { name: "postgresql", op: "db" };
  }
  if (originalOp.includes("http.client") || originalOp.includes("fetch")) {
    return { name: "external.http", op: "http.client" };
  }
  return { name: `${service}.request`, op: "server" };
}

/** Removes raw URLs, headers, query strings, SQL values, and arbitrary span data. */
export function sanitizeTelemetrySpan(span: SentrySpanJson, config: MonitoringConfig): SentrySpanJson {
  const normalized = normalizedSpanName(span, "web");
  const operation = safeOperation(span.data["monitor.operation"] ?? span.description);
  const statusCode = span.data["http.response.status_code"];
  return {
    trace_id: span.trace_id,
    span_id: span.span_id,
    start_timestamp: span.start_timestamp,
    ...(span.timestamp === undefined ? {} : { timestamp: span.timestamp }),
    ...(span.parent_span_id === undefined ? {} : { parent_span_id: span.parent_span_id }),
    ...(span.status === undefined ? {} : { status: span.status }),
    description: normalized.name,
    op: normalized.op,
    data: {
      "service.name": config.service,
      "monitor.operation": operation,
      ...(typeof statusCode === "number" ? { "http.response.status_code": statusCode } : {})
    }
  };
}

export function initializeWebTelemetry(source: EnvironmentSource = process.env): MonitoringConfig {
  const config = loadMonitoringConfig(source, "web");
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
    initialScope: { tags: { service: "web" } },
    beforeBreadcrumb: () => null,
    beforeSend: (event) => sanitizeTelemetryEvent(event, config) as ErrorEvent,
    beforeSendTransaction: (event) => sanitizeTelemetryEvent(event, config),
    beforeSendSpan: (span) => sanitizeTelemetrySpan(span, config)
  });
  return config;
}

export function captureServerError(
  error: unknown,
  context: { readonly operation: WebOperation; readonly requestId?: string }
): void {
  const diagnostic = describeError(error);
  try {
    telemetryAdapter.getActiveSpan()?.setStatus({ code: 2, message: "internal_error" });
    telemetryAdapter.captureException(safeError(diagnostic), {
      tags: {
        service: "web",
        operation: context.operation,
        error_name: diagnostic.errorName,
        error_code: diagnostic.errorCode
      },
      ...(context.requestId !== undefined && REQUEST_ID_PATTERN.test(context.requestId)
        ? { extra: { request_id: context.requestId } }
        : {})
    });
  } catch {
    // Monitoring must never change an application outcome.
  }
  try {
    logStructured("error", "web.request_failed", {
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      action: context.operation,
      statusCode: 500,
      errorName: diagnostic.errorName,
      errorCode: diagnostic.errorCode
    });
  } catch {
    // A broken telemetry/log sink must not replace the original response.
  }
}

function markSpanFailed(span: SpanHandle): void {
  try {
    span.setStatus({ code: 2, message: "internal_error" });
  } catch {
    // Tracing is never allowed to affect application control flow.
  }
}

export function withServerOperation<Arguments extends unknown[], Result>(
  operation: WebOperation,
  handler: (...args: Arguments) => Promise<Result>
): (...args: Arguments) => Promise<Result> {
  return async (...args: Arguments): Promise<Result> => {
    let execution: Promise<Result> | undefined;
    const executeOnce = (span?: SpanHandle): Promise<Result> => {
      if (execution !== undefined) {
        return execution;
      }
      execution = Promise.resolve().then(async () => {
        try {
          const result = await handler(...args);
          if (result instanceof Response && result.status >= 500 && span !== undefined) {
            markSpanFailed(span);
          }
          return result;
        } catch (error) {
          if (span !== undefined) {
            markSpanFailed(span);
          }
          throw error;
        }
      });
      return execution;
    };
    try {
      await telemetryAdapter.startSpan(
        {
          name: operation,
          op: "server.operation",
          kind: 1,
          forceTransaction: true,
          attributes: { "service.name": "web", "monitor.operation": operation }
        },
        (span) => executeOnce(span)
      );
    } catch {
      return executeOnce();
    }
    return executeOnce();
  };
}

const ROUTE_OPERATIONS: Readonly<Record<string, WebOperation>> = {
  "/api/auth/magic-link/request": "auth.magic_link.request",
  "/api/auth/magic-link/redeem": "auth.magic_link.redeem",
  "/auth/redeem": "auth.magic_link.redeem",
  "/api/roles/[roleId]/files": "file.intake.create",
  "/api/roles/[roleId]/files/[intakeId]/complete": "file.upload.complete",
  "/api/roles/[roleId]/files/[intakeId]/validate": "file.validate",
  "/api/roles/[roleId]/files/[intakeId]/extract-text": "file.extract_text",
  "/api/roles/[roleId]/files/[intakeId]/csv-preview": "csv.preview",
  "/api/roles/[roleId]/files/[intakeId]/finalize": "csv.finalize",
  "/api/roles/[roleId]/applications": "application.review_queue",
  "/api/roles/[roleId]/applications/[applicationId]/evidence": "application.evidence",
  "/api/roles/[roleId]/applications/[applicationId]/evidence/[criterionId]/corrections": "application.evidence.correct",
  "/api/roles/[roleId]/applications/[applicationId]/decisions": "application.decision",
  "/api/me/organizations": "organization.list",
  "/api/invites": "invite.create"
};

export function operationForRoute(routePath: string): WebOperation {
  return ROUTE_OPERATIONS[routePath] ?? "web.request";
}
