import assert from "node:assert/strict";
import test from "node:test";

import {
  LOG_EVENT_NAMES,
  buildLogEntry,
  createConsoleMagicLinkEmailSender,
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
  // errorCode is now a closed set (API_ERROR_CODES) rather than a
  // character shape, so this fixture uses a real code. The previous
  // "db_error" was invented and only passed because anything
  // lowercase-with-punctuation did -- which is the gap that let
  // `alice.smith` through as well.
  const entry = buildLogEntry("info", "worker.ready", {
    statusCode: "200" as unknown as number,
    durationMs: -1,
    errorCode: "internal_error"
  });
  assert.equal(entry.context?.statusCode, undefined);
  assert.equal(entry.context?.durationMs, undefined);
  assert.equal(entry.context?.errorCode, "internal_error");
  assert.equal(JSON.stringify(entry).includes("[REDACTED]"), false);
});

test("an error code outside the published set is redacted rather than trusted", () => {
  const entry = buildLogEntry("info", "worker.ready", { errorCode: "db_error" });
  assert.equal(entry.context?.errorCode, "[REDACTED]");
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

test("the development magic-link sender keeps local dev output non-sensitive", async (t) => {
  const stderrMock = t.mock.method(process.stderr, "write", () => true);
  const logMock = t.mock.method(console, "log", () => undefined);
  const link = "http://localhost:3000/auth/redeem?token=abc123";

  await createConsoleMagicLinkEmailSender("development").sendMagicLink({
    email: "dev@example.test",
    link
  });

  // Rewritten: this previously asserted that the token was redacted from
  // terminal output, which is the defect Codex found rather than a
  // property worth keeping. A link a developer cannot open is the same
  // outcome as the silent no-op this adapter replaced. The boundary that
  // matters is the retained log stream, not the terminal of the person
  // who just asked for the link -- and the constructor already refuses
  // to run anywhere the token would be worth anything.
  const written = stderrMock.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.equal(written.includes(link), true, "the developer must receive a link they can actually open");
  assert.equal(written.includes("dev@example.test"), false, "the recipient is still redacted; nothing needs it");

  // The structured log records delivery and must still carry neither the
  // credential nor the recipient. That half is unchanged and is the part
  // that was always doing the real work.
  const logged = logMock.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.equal(logged.includes(link), false);
  assert.equal(logged.includes("dev@example.test"), false);
  assert.equal(logged.includes("abc123"), false);
});

test("the development magic-link sender refuses to run in a hosted environment", () => {
  for (const appEnv of ["staging", "production"]) {
    assert.throws(() => createConsoleMagicLinkEmailSender(appEnv), /local-development only/);
  }
});

// ---- AF-21 follow-up: three findings from Codex's review of PR #54 ----

test("an invalid date-shaped digit run is redacted, not protected as a date", () => {
  // The leak: `1234-56-78` is an eight-digit phone, but it matched the
  // dddd-dd-dd shape, so every digit counted as covered by a "date" span
  // and redactPii returned it unchanged. Verified before the fix.
  for (const value of ["1234-56-78", "0000-99-99", "1234-13-45", "2026-02-30", "2026-02-29"]) {
    assert.equal(redactPii(value), "[REDACTED]", `${value} is not a real date and must not shield a phone`);
  }
  assert.equal(redactPii("Call 1234-56-78 now"), "Call [REDACTED] now");
});

test("a real calendar date is still protected, including a leap day", () => {
  // The negative half: over-tightening would destroy the correlation
  // timestamps this protection exists for.
  for (const value of ["2026-08-21", "2024-02-29", "2000-02-29", "2026-12-31"]) {
    assert.equal(redactPii(value), value, `${value} is a real date and must survive`);
  }
  // ...and a phone adjacent to a real date is still caught.
  assert.equal(redactPii("Call +1 2026-08-21 now"), "Call [REDACTED] now");
});

test("human-derived context values are rejected, not emitted because they look like tokens", () => {
  // `action`, `entityType`, `entityId` and `errorCode` were validated by
  // a character shape, which `alice`, `alice.smith` and `interview_alice`
  // all satisfy -- and redactPii does not recognise a name as email or
  // phone, so they reached retained logs verbatim.
  const entry = buildLogEntry("info", "auth.magic_link_requested", {
    action: "alice.smith",
    entityType: "interview_alice",
    entityId: "alice",
    errorCode: "ssn.123-45-6789"
  });
  assert.deepEqual(entry.context, {
    action: "[REDACTED]",
    entityType: "[REDACTED]",
    entityId: "[REDACTED]",
    errorCode: "[REDACTED]"
  });
});

test("the closed vocabularies the system already owns are accepted unchanged", () => {
  // Without this, "reject everything" would pass the test above while
  // making the fields useless.
  const entry = buildLogEntry("info", "auth.magic_link_requested", {
    action: "decision_recorded",
    entityType: "application",
    entityId: "11111111-1111-4111-8111-111111111111",
    errorCode: "not_found"
  });
  assert.deepEqual(entry.context, {
    action: "decision_recorded",
    entityType: "application",
    entityId: "11111111-1111-4111-8111-111111111111",
    errorCode: "not_found"
  });
});

test("the dev magic link is printed in full, because a redacted one cannot be used", () => {
  // This adapter exists so a developer can complete local sign-in.
  // Redacting the token left a link that cannot be opened -- the same
  // outcome as the silent no-op it replaced. The environment guard, not
  // the redaction, is what keeps this safe.
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    void createConsoleMagicLinkEmailSender("development").sendMagicLink({
      email: "dev@example.test",
      link: "http://localhost:3000/auth/redeem?token=abc123&next=/roles"
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  const output = written.join("");
  assert.match(output, /token=abc123/, "the developer must receive a link they can actually open");
  assert.doesNotMatch(output, /dev@example\.test/, "the recipient stays redacted: nothing needs it");
});

test("a hosted environment still refuses to construct the console sender at all", () => {
  // Printing the token is only acceptable because this cannot run where
  // the token would matter.
  for (const appEnv of ["staging", "production"]) {
    assert.throws(() => createConsoleMagicLinkEmailSender(appEnv), /local-development only/);
  }
});
