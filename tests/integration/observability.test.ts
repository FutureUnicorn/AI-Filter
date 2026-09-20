import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadMonitoringConfig } from "../../packages/config/src/index.ts";
import { checkInferenceBudget } from "../../packages/domain/src/index.ts";
import {
  buildInferenceBudgetTelemetry,
  recordInferenceBudgetTelemetry,
  sanitizeWorkerEvent,
  setWorkerTelemetryAdapterForTesting
} from "../../apps/worker/src/observability.ts";
import {
  MONITORED_OPERATIONS,
  buildDetectorDefinitions
} from "../../scripts/observability/sentry-alerts.mjs";

const REQUEST_ID = "req_44444444-4444-4444-8444-444444444444";
interface TestSpanHandle {
  setStatus(status: unknown): unknown;
}
interface WebObservabilityModule {
  captureServerError(error: unknown, context: { requestId?: string; operation: string }): void;
  sanitizeTelemetryEvent(event: Record<string, unknown>, config: ReturnType<typeof loadMonitoringConfig>): Record<string, unknown>;
  sanitizeTelemetrySpan(
    span: { trace_id: string; span_id: string; start_timestamp: number; timestamp?: number; description?: string; op?: string; data: Record<string, unknown> },
    config: ReturnType<typeof loadMonitoringConfig>
  ): { description?: string; op?: string; data: Record<string, unknown> };
  setWebTelemetryAdapterForTesting(adapter: {
    captureException(error: Error, context: { tags: Record<string, string>; extra?: Record<string, string> }): unknown;
    getActiveSpan(): TestSpanHandle | undefined;
    startSpan<T>(options: Record<string, unknown>, callback: (span: TestSpanHandle) => T | Promise<T>): T | Promise<T>;
  } | undefined): void;
  withServerOperation<Arguments extends unknown[], Result>(
    operation: string,
    handler: (...args: Arguments) => Promise<Result>
  ): (...args: Arguments) => Promise<Result>;
}
const webObservabilityUrl = new URL("../../apps/web/src/lib/observability.ts", import.meta.url).href;
const {
  captureServerError,
  sanitizeTelemetryEvent,
  sanitizeTelemetrySpan,
  setWebTelemetryAdapterForTesting,
  withServerOperation
} = (await import(webObservabilityUrl)) as WebObservabilityModule;
const monitoringSource = {
  APP_ENV: "test",
  DEPLOYMENT_COMMIT_SHA: "abc1234",
  SENTRY_DSN: "https://public-key@sentry.example/123",
  SENTRY_TRACES_SAMPLE_RATE: "1"
} as const;
const webConfig = loadMonitoringConfig(monitoringSource, "web");
const workerConfig = loadMonitoringConfig(monitoringSource, "worker");

test("handled server failures capture only a generic error plus request correlation", (t) => {
  const captures: Array<{ error: Error; context: { tags: Record<string, string>; extra?: Record<string, string> } }> = [];
  const statuses: unknown[] = [];
  t.mock.method(console, "error", () => undefined);
  setWebTelemetryAdapterForTesting({
    captureException(error, context) {
      captures.push({ error, context });
    },
    getActiveSpan() {
      return { setStatus(status) { statuses.push(status); } };
    },
    startSpan(_options, callback) {
      return callback({ setStatus(status) { statuses.push(status); } });
    }
  });
  t.after(() => setWebTelemetryAdapterForTesting(undefined));

  captureServerError(new Error("Alice Example resume.pdf contained private text"), {
    requestId: REQUEST_ID,
    operation: "file.extract_text"
  });

  assert.equal(captures.length, 1);
  assert.equal(captures[0]?.error.name, "ServerOperationError");
  assert.equal(captures[0]?.error.message, "Unexpected server failure");
  assert.equal(captures[0]?.error.stack?.includes("Alice Example"), false);
  assert.deepEqual(captures[0]?.context, {
    tags: { service: "web", operation: "file.extract_text" },
    extra: { request_id: REQUEST_ID }
  });
  assert.equal(statuses.length, 1);
});

test("expected 4xx outcomes are traced but never reported as application failures", async (t) => {
  const captures: Error[] = [];
  const statuses: unknown[] = [];
  const starts: Array<Record<string, unknown>> = [];
  setWebTelemetryAdapterForTesting({
    captureException(error) { captures.push(error); },
    getActiveSpan() { return undefined; },
    startSpan(options, callback) {
      starts.push(options);
      return callback({ setStatus(status) { statuses.push(status); } });
    }
  });
  t.after(() => setWebTelemetryAdapterForTesting(undefined));

  const handler = withServerOperation("file.validate", async () => Response.json({ code: "invalid_request" }, { status: 400 }));
  const response = await handler();
  assert.equal(response.status, 400);
  assert.equal(captures.length, 0);
  assert.equal(statuses.length, 0);
  assert.equal(starts[0]?.name, "file.validate");
  assert.deepEqual(starts[0]?.attributes, {
    "service.name": "web",
    "monitor.operation": "file.validate"
  });
});

test("telemetry adapter failure never changes a request or capture outcome", async (t) => {
  let calls = 0;
  t.mock.method(console, "error", () => undefined);
  setWebTelemetryAdapterForTesting({
    captureException() { throw new Error("telemetry down"); },
    getActiveSpan() { throw new Error("telemetry down"); },
    startSpan() { throw new Error("telemetry down"); }
  });
  t.after(() => setWebTelemetryAdapterForTesting(undefined));

  assert.doesNotThrow(() => captureServerError(new Error("application failure"), {
    requestId: REQUEST_ID,
    operation: "role.list"
  }));
  const handler = withServerOperation("application.review_queue", async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  });
  assert.equal((await handler()).status, 204);
  assert.equal(calls, 1, "falling back after a tracing failure must not duplicate application work");
});

test("the final event and span allowlists remove request PII and high-cardinality IDs", () => {
  const event = {
    event_id: "a".repeat(32),
    transaction: "/api/roles/111/applications/222",
    request: {
      url: "https://app.test/api?email=alice@example.test",
      headers: { authorization: "Bearer secret", cookie: "session=secret" },
      data: "resume text"
    },
    user: { email: "alice@example.test", username: "Alice Example" },
    breadcrumbs: [{ message: "resume evidence quote" }],
    tags: { operation: "file.extract_text", organization_id: "33333333-3333-4333-8333-333333333333" },
    extra: { request_id: REQUEST_ID, filename: "Alice Example resume.pdf", prompt: "private prompt" },
    exception: {
      values: [{
        type: "Error",
        value: "Alice Example resume.pdf",
        stacktrace: { frames: [{ filename: "C:/uploads/Alice Example resume.pdf", function: "extract", lineno: 12 }] }
      }]
    }
  };
  const cleanEvent = sanitizeTelemetryEvent(event, webConfig);
  const serializedEvent = JSON.stringify(cleanEvent);
  for (const forbidden of ["alice@example.test", "Alice Example", "resume text", "private prompt", "Bearer secret", "33333333-"]) {
    assert.equal(serializedEvent.includes(forbidden), false, `event leaked ${forbidden}`);
  }
  assert.match(serializedEvent, /file\.extract_text/u);
  assert.match(serializedEvent, new RegExp(REQUEST_ID, "u"));

  const cleanSpan = sanitizeTelemetrySpan({
    trace_id: "a".repeat(32),
    span_id: "b".repeat(16),
    start_timestamp: 1,
    timestamp: 2,
    description: "/api/roles/111/applications/222?email=alice@example.test",
    op: "http.server",
    data: {
      "http.url": "https://app.test/private/222",
      "http.request.body": "resume text",
      "monitor.operation": "application.evidence"
    }
  }, webConfig);
  assert.equal(cleanSpan.description, "application.evidence");
  assert.equal(cleanSpan.op, "server.operation");
  assert.deepEqual(cleanSpan.data, {
    "service.name": "web",
    "monitor.operation": "application.evidence"
  });
});

test("token-budget telemetry reuses ok, warning, and capped decisions without money", async (t) => {
  const config = { maxTokensPerPeriod: 1000, alertThresholdRatio: 0.8 };
  const values = [
    { used: 799, outcome: "ok" },
    { used: 800, outcome: "warning" },
    { used: 1000, outcome: "capped" }
  ] as const;
  for (const value of values) {
    const usage = { tokensUsedThisPeriod: value.used };
    const telemetry = buildInferenceBudgetTelemetry(checkInferenceBudget(usage, config), usage, config);
    assert.equal(telemetry.status, value.outcome);
    assert.equal(telemetry.utilization, value.used / 1000);
    assert.doesNotMatch(JSON.stringify(telemetry), /cost|price|dollar|rupee|currency/iu);
  }

  const starts: Array<Record<string, unknown>> = [];
  setWorkerTelemetryAdapterForTesting({
    captureException() { return undefined; },
    startSpan(options, callback) {
      starts.push(options);
      return callback({ setStatus() { return undefined; }, setAttributes() { return undefined; } });
    }
  });
  t.after(() => setWorkerTelemetryAdapterForTesting(undefined));
  await recordInferenceBudgetTelemetry({
    status: "warning",
    utilization: 0.8,
    tokensUsedThisPeriod: 800,
    maxTokensPerPeriod: 1000
  });
  assert.equal(starts[0]?.name, "inference.token_budget");
  assert.equal((starts[0]?.attributes as Record<string, unknown>)["monitor.budget.status"], "warning");
});

test("worker event allowlisting drops arbitrary context", () => {
  const clean = sanitizeWorkerEvent({
    tags: { operation: "worker.job", application_id: "secret-id" },
    extra: { prompt: "private prompt", response: "raw provider response" },
    user: { email: "candidate@example.test" },
    exception: { values: [{ value: "candidate@example.test", type: "Error" }] }
  }, workerConfig);
  const serialized = JSON.stringify(clean);
  assert.match(serialized, /Unexpected worker failure/u);
  assert.doesNotMatch(serialized, /candidate@example\.test|private prompt|raw provider response|secret-id/u);
});

test("alert definitions require external thresholds and omit the blocked queue-age signal", () => {
  const thresholds = Object.fromEntries(MONITORED_OPERATIONS.map((operation) => [operation, 1000]));
  const definitions = buildDetectorDefinitions({
    APP_ENV: "staging",
    SENTRY_WEB_PROJECT: "web",
    SENTRY_WORKER_PROJECT: "worker",
    SENTRY_ALERT_EVALUATION_WINDOW_SECONDS: "300",
    SENTRY_ALERT_MIN_EVENT_VOLUME: "20",
    SENTRY_ALERT_ERROR_RATE_THRESHOLD_PERCENT: "5",
    SENTRY_ALERT_WORKER_ERROR_COUNT_THRESHOLD: "1",
    SENTRY_ALERT_TOKEN_BUDGET_EVENT_THRESHOLD: "1",
    SENTRY_ALERT_P95_THRESHOLDS_MS: JSON.stringify(thresholds)
  });
  assert.equal(definitions.length, MONITORED_OPERATIONS.length + 3);
  const serialized = JSON.stringify(definitions);
  assert.match(serialized, /failure_rate\(\)/u);
  assert.match(serialized, /p95\(span\.duration\)/u);
  assert.match(serialized, /inference\.token_budget/u);
  assert.doesNotMatch(serialized, /queue\.age|dollar|rupee|currency/iu);
  assert.throws(
    () => buildDetectorDefinitions({}),
    /required to render AF-67 alert definitions/u
  );
});

test("every handled web 500 uses the safe capture abstraction and all required operations are normalized", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const webSource = path.join(root, "apps/web/src");
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name.endsWith(".ts")) files.push(entryPath);
    }
  };
  walk(webSource);
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /console\.error/u);
  assert.match(source, /captureServerError/u);
  for (const operation of MONITORED_OPERATIONS) {
    assert.match(source, new RegExp(`withServerOperation\\("${operation.replaceAll(".", "\\.")}"`, "u"));
  }
});
