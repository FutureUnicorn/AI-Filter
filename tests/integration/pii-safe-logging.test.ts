import assert from "node:assert/strict";
import test from "node:test";

import { buildLogEntry, logStructured, redactPii } from "../../packages/security/src/index.ts";

test("redactPii masks an email address embedded in a larger string", () => {
  const result = redactPii("Contact recruiter@acme.test about the offer.");
  assert.equal(result, "Contact [REDACTED] about the offer.");
});

test("redactPii masks a unicode email that the ASCII-only pattern would miss", () => {
  const result = redactPii("Contact user@exämple.test about the offer.");
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

test("redactPii preserves UUIDs, request IDs, ISO dates, and IPv4 addresses", () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  const requestId = "req_44444444-4444-4444-8444-444444444444";
  const result = redactPii(`${uuid} ${requestId} 2026-08-21 192.0.2.1`);
  assert.equal(result, `${uuid} ${requestId} 2026-08-21 192.0.2.1`);
});

test("redactPii does not treat caller-supplied __SA_ID_n__ text as a restore marker", () => {
  assert.equal(redactPii("entity-__SA_ID_0__"), "entity-__SA_ID_0__");
  const uuid = "11111111-1111-4111-8111-111111111111";
  assert.equal(redactPii(`entity-__SA_ID_0__ ${uuid}`), `entity-__SA_ID_0__ ${uuid}`);
});

test("buildLogEntry rejects free-text messages instead of logging interpolated PII", () => {
  const entry = buildLogEntry(
    "info",
    "Sent invite to newhire@acme.test",
    undefined,
    new Date("2026-08-21T12:00:00.000Z")
  );
  assert.equal(entry.message, "log.rejected_message");
  assert.equal(entry.timestamp, "2026-08-21T12:00:00.000Z");
  assert.equal(entry.context, undefined);
});

test("buildLogEntry redacts PII-shaped values inside allowlisted context keys", () => {
  const entry = buildLogEntry("warn", "entity.unexpected_value", {
    entityId: "leaked-owner@acme.test",
    organizationId: "org-1"
  });
  assert.equal(entry.context?.entityId, "[REDACTED]");
  assert.equal(entry.context?.organizationId, "org-1");
});

test("buildLogEntry drops undeclared context keys such as candidateName", () => {
  const entry = buildLogEntry("info", "request.completed", {
    requestId: "req_1",
    candidateName: "Alice Smith"
  } as { requestId: string });
  assert.equal(entry.context?.requestId, "req_1");
  assert.equal("candidateName" in (entry.context ?? {}), false);
});

test("buildLogEntry leaves non-string context values (statusCode, durationMs) untouched", () => {
  const entry = buildLogEntry("info", "request.completed", { statusCode: 200, durationMs: 42 });
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
  logStructured("error", "something.broke");
  assert.equal(logMock.mock.calls.length, 0);
  assert.equal(errorMock.mock.calls.length, 1);
});
