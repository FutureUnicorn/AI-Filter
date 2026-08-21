import assert from "node:assert/strict";
import test from "node:test";

import { buildLogEntry, logStructured, redactPii } from "../../packages/security/src/index.ts";

test("redactPii masks an email address embedded in a larger string", () => {
  const result = redactPii("Contact recruiter@acme.test about the offer.");
  assert.equal(result, "Contact [REDACTED] about the offer.");
});

test("redactPii masks a phone number embedded in a larger string", () => {
  const result = redactPii("Call +1 (555) 123-4567 to confirm.");
  assert.equal(result, "Call [REDACTED] to confirm.");
});

test("redactPii leaves ordinary text and short numbers untouched", () => {
  const result = redactPii("Application moved to screening, 3 of 5 steps done.");
  assert.equal(result, "Application moved to screening, 3 of 5 steps done.");
});

test("buildLogEntry redacts PII interpolated straight into the message", () => {
  const entry = buildLogEntry("info", "Sent invite to newhire@acme.test", undefined, new Date("2026-08-21T12:00:00.000Z"));
  assert.equal(entry.message, "Sent invite to [REDACTED]");
  assert.equal(entry.timestamp, "2026-08-21T12:00:00.000Z");
  assert.equal(entry.context, undefined);
});

test("buildLogEntry redacts PII-shaped values inside context, if any slip in", () => {
  const entry = buildLogEntry("warn", "Unexpected value in entityId", {
    entityId: "leaked-owner@acme.test",
    organizationId: "org-1"
  });
  assert.equal(entry.context?.entityId, "[REDACTED]");
  assert.equal(entry.context?.organizationId, "org-1");
});

test("buildLogEntry leaves non-string context values (statusCode, durationMs) untouched", () => {
  const entry = buildLogEntry("info", "request completed", { statusCode: 200, durationMs: 42 });
  assert.equal(entry.context?.statusCode, 200);
  assert.equal(entry.context?.durationMs, 42);
});

test("logStructured emits one parseable JSON line to stdout for info/debug", (t) => {
  const logMock = t.mock.method(console, "log", () => undefined);
  logStructured("info", "hello", { requestId: "req_1" });
  assert.equal(logMock.mock.calls.length, 1);
  const parsed = JSON.parse(logMock.mock.calls[0]?.arguments[0] as string);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.message, "hello");
  assert.equal(parsed.context.requestId, "req_1");
});

test("logStructured emits to stderr for warn/error, not stdout", (t) => {
  const logMock = t.mock.method(console, "log", () => undefined);
  const errorMock = t.mock.method(console, "error", () => undefined);
  logStructured("error", "something broke");
  assert.equal(logMock.mock.calls.length, 0);
  assert.equal(errorMock.mock.calls.length, 1);
});
