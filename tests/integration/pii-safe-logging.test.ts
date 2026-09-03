import assert from "node:assert/strict";
import test from "node:test";

import {
  LOG_EVENT_NAMES,
  buildLogEntry,
  createConsoleMagicLinkEmailSender,
  createMagicLinkEmailSender,
  logStructured,
  redactPii
} from "../../packages/security/src/index.ts";

const ORG_UUID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "req_44444444-4444-4444-8444-444444444444";

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
  const entry = buildLogEntry("warn", "worker.ready", {
    entityId: "leaked-owner@acme.test",
    organizationId: ORG_UUID
  });
  assert.equal(entry.context?.entityId, "[REDACTED]");
  assert.equal(entry.context?.organizationId, ORG_UUID);
});

test("buildLogEntry drops undeclared context keys such as candidateName", () => {
  const entry = buildLogEntry("info", "worker.ready", {
    requestId: REQUEST_ID,
    candidateName: "Alice Smith"
  } as { requestId: string });
  assert.equal(entry.context?.requestId, REQUEST_ID);
  assert.equal("candidateName" in (entry.context ?? {}), false);
});

test("buildLogEntry leaves valid numeric context values (statusCode, durationMs) untouched", () => {
  const entry = buildLogEntry("info", "worker.ready", { statusCode: 200, durationMs: 42 });
  assert.equal(entry.context?.statusCode, 200);
  assert.equal(entry.context?.durationMs, 42);
});

test("buildLogEntry drops invalid numeric context values instead of coercing them to strings", () => {
  const entry = buildLogEntry("info", "worker.ready", {
    statusCode: "200" as unknown as number,
    durationMs: -1,
    errorCode: "db_error"
  });
  assert.equal(entry.context?.statusCode, undefined);
  assert.equal(entry.context?.durationMs, undefined);
  assert.equal(entry.context?.errorCode, "db_error");
  assert.equal(JSON.stringify(entry).includes("[REDACTED]"), false);
});

test("logStructured emits one parseable JSON line to stdout for info/debug", (t) => {
  const logMock = t.mock.method(console, "log", () => undefined);
  logStructured("info", "worker.ready", { requestId: REQUEST_ID });
  assert.equal(logMock.mock.calls.length, 1);
  const parsed = JSON.parse(logMock.mock.calls[0]?.arguments[0] as string);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.message, "worker.ready");
  assert.equal(parsed.context.requestId, REQUEST_ID);
});

test("logStructured emits to stderr for warn/error, not stdout", (t) => {
  const logMock = t.mock.method(console, "log", () => undefined);
  const errorMock = t.mock.method(console, "error", () => undefined);
  logStructured("error", "something.broke");
  assert.equal(logMock.mock.calls.length, 0);
  assert.equal(errorMock.mock.calls.length, 1);
});

test("redactPii does not corrupt input that contains literal text shaped like its own internal placeholder", () => {
  // Two real UUIDs (so the internal span-collection mechanism has real
  // work to do) plus literal text that looks exactly like the shape an
  // older marker-based implementation would have generated internally
  // (e.g. "__SA_ID_0__") -- that literal text must survive untouched,
  // not get overwritten by an unrelated protected value.
  const uuidA = "11111111-1111-4111-8111-111111111111";
  const uuidB = "22222222-2222-4222-8222-222222222222";
  const input = `${uuidA} literal text __SA_ID_0__ should survive ${uuidB}`;
  const result = redactPii(input);
  assert.equal(result, input);
});

test("redactPii preserves multiple protected spans without dropping the redaction between them", () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  const date = "2026-08-21";
  const result = redactPii(`Created ${uuid} on ${date} from 192.0.2.1, contact recruiter@acme.test`);
  assert.equal(result, `Created ${uuid} on ${date} from 192.0.2.1, contact [REDACTED]`);
});

test("buildLogEntry emits a registered event name unchanged", () => {
  for (const name of LOG_EVENT_NAMES) {
    assert.equal(buildLogEntry("info", name).message, name);
  }
});

// ---- Codex review findings on AF-21 ----

test("an unregistered event name is rejected even when it looks like a dotted key", () => {
  // The old check was a character class, so any user-derived text made of
  // permitted characters was emitted verbatim as the message. These are
  // the exact examples raised in review.
  for (const forged of ["alice.smith", "ssn.123-45-6789", "job.batch.completed.1234567890123"]) {
    assert.equal(buildLogEntry("info", forged).message, "log.rejected_message");
  }
});

test("a non-primitive value in an allowlisted string field cannot smuggle PII through", () => {
  const entry = buildLogEntry("info", "worker.ready", {
    action: { email: "candidate@acme.test" }
  } as unknown as { action: string });
  assert.equal(entry.context?.action, "[REDACTED]");
  assert.equal(JSON.stringify(entry).includes("candidate@acme.test"), false);
});

test("an allowlisted string field that is not identifier-shaped is redacted", () => {
  // Names, free text and local phone fragments are not email- or
  // long-phone-shaped, so redactPii alone let them through verbatim.
  const entry = buildLogEntry("warn", "worker.ready", {
    entityId: "Alice Smith",
    action: "Interview Jane Doe",
    errorCode: "555-1234"
  } as unknown as { entityId: string; action: string; errorCode: string });
  assert.equal(entry.context?.entityId, "[REDACTED]");
  assert.equal(entry.context?.action, "[REDACTED]");
  assert.equal(entry.context?.errorCode, "[REDACTED]");
});

test("redactPii redacts an email or phone that contains an identifier-shaped substring", () => {
  // Carving the identifier out mid-token used to leave the PII pattern
  // unable to match, so the whole value leaked verbatim.
  assert.equal(redactPii("user@192.0.2.1"), "[REDACTED]");
  assert.equal(redactPii("user@2026-08-21.com"), "[REDACTED]");
  assert.equal(redactPii("Call +1 2026-08-21 now"), "Call [REDACTED] now");
});

test("redactPii keeps several adjacent correlation identifiers intact", () => {
  // A loose phone shape could start inside one identifier and run through
  // the next, reading the whole run as one number and destroying all of them.
  const value = `11111111-1111-4111-8111-111111111111 ${REQUEST_ID} 2026-08-21 192.0.2.1`;
  assert.equal(redactPii(value), value);
});

// This test previously asserted the OPPOSITE of what it now asserts, and
// that inversion is the point. It required the token to be redacted from
// stderr as well as from the log stream, which left no channel at all
// yielding a usable link: the request stored a valid token, returned 202,
// and the redeem endpoint was unreachable without hand-editing the
// database. The real boundary is between the two channels, not "redact
// everywhere" -- logStructured output is retained and searchable, so a
// credential must never enter it, while stderr in a local environment is
// the deliberate local-only delivery channel.
test("the development magic-link sender delivers a usable link on stderr and nothing sensitive to the log stream", async (t) => {
  const stderrMock = t.mock.method(process.stderr, "write", () => true);
  const logMock = t.mock.method(console, "log", () => undefined);
  const link = "http://localhost:3000/auth/redeem?token=abc123";

  await createConsoleMagicLinkEmailSender("development").sendMagicLink({
    email: "dev@example.test",
    link
  });

  // stderr: the local developer must be able to complete a sign-in.
  const written = stderrMock.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.equal(written.includes(link), true, "a local developer must be able to obtain the real link");
  assert.equal(written.includes("token=abc123"), true, "a redacted token cannot be redeemed");

  // The retained structured log must still carry neither the credential
  // nor the recipient. This half is unchanged and must stay true.
  const logged = logMock.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.equal(logged.includes(link), false, "the retained log stream must not carry the bearer credential");
  assert.equal(logged.includes("dev@example.test"), false, "the retained log stream must not carry the recipient");
  assert.equal(logged.includes("abc123"), false);
  assert.match(logged, /magic_link\.queued/, "delivery is still recorded as a non-PII event");
});

test("the development magic-link sender refuses to run in a hosted environment", () => {
  for (const appEnv of ["staging", "production"]) {
    assert.throws(() => createConsoleMagicLinkEmailSender(appEnv), /local-development only/);
  }
});

// The guard above was unreachable in practice until this round: the route
// called createConsoleMagicLinkEmailSender() with no argument, so appEnv
// defaulted to "development" no matter where the code was deployed.
test("hosted selection fails closed instead of degrading to the console sender", () => {
  for (const appEnv of ["staging", "production"]) {
    assert.throws(
      () => createMagicLinkEmailSender({ appEnv }),
      /refusing to fall back to the local console sender/,
      `${appEnv} without delivery configuration must not silently use the console sender`
    );
  }
});

test("local selection uses the console sender, and honours configured delivery when present", () => {
  // No delivery configured: the console sender, which is what makes a
  // local sign-in completable at all.
  assert.doesNotThrow(() => createMagicLinkEmailSender({ appEnv: "development" }));
  // Delivery configured locally (a mail catcher, say) is honoured rather
  // than overridden.
  assert.doesNotThrow(() =>
    createMagicLinkEmailSender({
      appEnv: "development",
      delivery: { endpoint: "https://mail.test/send", apiKey: "k", from: "no-reply@acme.test" }
    })
  );
});
