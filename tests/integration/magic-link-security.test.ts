import assert from "node:assert/strict";
import test from "node:test";

import {
  createConsoleMagicLinkEmailSender,
  generateMagicLinkToken,
  hashMagicLinkToken,
  verifyMagicLinkToken
} from "../../packages/security/src/index.ts";

test("generateMagicLinkToken produces a token whose hash matches hashMagicLinkToken", () => {
  const generated = generateMagicLinkToken();
  assert.equal(hashMagicLinkToken(generated.token), generated.tokenHash);
});

test("generateMagicLinkToken produces distinct, high-entropy tokens", () => {
  const first = generateMagicLinkToken();
  const second = generateMagicLinkToken();
  assert.notEqual(first.token, second.token);
  assert.ok(first.token.length >= 32);
});

test("generateMagicLinkToken respects a custom TTL relative to a fixed clock", () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  const generated = generateMagicLinkToken(now, 5 * 60 * 1000);
  assert.equal(generated.expiresAt.toISOString(), "2026-08-21T12:05:00.000Z");
});

test("a token hash that never existed is not_found", () => {
  const result = verifyMagicLinkToken({ justRedeemed: false, record: undefined });
  assert.deepEqual(result, { outcome: "not_found" });
});

test("a plain login token that this call just redeemed is valid with no invite", () => {
  const result = verifyMagicLinkToken({
    justRedeemed: true,
    record: {
      email: "user@acme.test",
      expiresAt: new Date("2026-08-21T12:15:00.000Z"),
      consumedAt: new Date("2026-08-21T12:01:00.000Z")
    }
  });
  assert.deepEqual(result, { outcome: "valid", email: "user@acme.test" });
});

test("an invite token that this call just redeemed carries the invite", () => {
  const result = verifyMagicLinkToken({
    justRedeemed: true,
    record: {
      email: "newhire@acme.test",
      invite: { organizationId: "org-1", role: "recruiter" },
      expiresAt: new Date("2026-08-21T12:15:00.000Z"),
      consumedAt: new Date("2026-08-21T12:01:00.000Z")
    }
  });
  assert.deepEqual(result, {
    outcome: "valid",
    email: "newhire@acme.test",
    invite: { organizationId: "org-1", role: "recruiter" }
  });
});

test("a token already consumed by an earlier call is distinct from a fresh redemption", () => {
  const result = verifyMagicLinkToken({
    justRedeemed: false,
    record: {
      email: "user@acme.test",
      expiresAt: new Date("2026-08-21T12:15:00.000Z"),
      consumedAt: new Date("2026-08-21T12:01:00.000Z")
    }
  });
  assert.deepEqual(result, { outcome: "already_consumed" });
});

test("an unconsumed but expired token is expired, not already_consumed", () => {
  const result = verifyMagicLinkToken(
    {
      justRedeemed: false,
      record: {
        email: "user@acme.test",
        expiresAt: new Date("2026-08-21T12:00:00.000Z")
      }
    },
    new Date("2026-08-21T13:00:00.000Z")
  );
  assert.deepEqual(result, { outcome: "expired" });
});

// These two tests asserted that the console sender redacted the token
// from stderr as well as from the log stream. That is the behaviour
// review (#28) rejected: it left no channel yielding a usable link, so
// the request endpoint minted a valid token, returned 202, and the redeem
// endpoint was unreachable without editing the database by hand.
//
// The property worth protecting is narrower and is still enforced below:
// the credential and the recipient must never enter the RETAINED
// structured log stream, which is shipped and searchable. stderr in a
// local environment is the deliberate delivery channel, and the
// hosted-environment guard is what keeps it local.
test("the console sender keeps the credential out of the retained log stream", async (t) => {
  const logMock = t.mock.method(console, "log", () => undefined);
  const errorMock = t.mock.method(console, "error", () => undefined);
  const stderrMock = t.mock.method(process.stderr, "write", () => true);
  const sender = createConsoleMagicLinkEmailSender("development");
  await sender.sendMagicLink({ email: "user@acme.test", link: "https://example.test/verify?token=abc" });

  // The retained stream: structured JSON via console.log / console.error.
  const logged = [
    ...logMock.mock.calls.map((call) => String(call.arguments[0])),
    ...errorMock.mock.calls.map((call) => String(call.arguments[0]))
  ].join("\n");
  assert.equal(logged.includes("user@acme.test"), false, "the recipient must not enter the retained log stream");
  assert.equal(logged.includes("token=abc"), false, "the credential must not enter the retained log stream");
  assert.match(logged, /magic_link\.queued/, "delivery is recorded as a non-PII event");

  // The local delivery channel: it must carry a redeemable link.
  const written = stderrMock.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.equal(written.includes("token=abc"), true, "a local developer must be able to redeem the link");
});

test("the console sender preserves every token parameter, so a duplicated one is still redeemable", async (t) => {
  // A duplicated query parameter is well-formed and nothing rejects it.
  // The earlier concern here was a redaction that stopped at the first
  // match; now that the local channel deliberately carries the real
  // link, the equivalent risk is a rewrite that mangles the link and
  // yields a token the redeem endpoint rejects. Assert it is verbatim.
  const stderrMock = t.mock.method(process.stderr, "write", () => true);
  const sender = createConsoleMagicLinkEmailSender("development");
  const link = "https://example.test/verify?a=1&token=FIRST_SECRET&b=2&token=SECOND_SECRET&c=3";
  await sender.sendMagicLink({ email: "user@acme.test", link });
  const written = stderrMock.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.equal(written.includes(link), true, "the link must reach the terminal byte-for-byte");
  assert.doesNotMatch(written, /\[REDACTED\]/u, "a redacted token cannot be redeemed");
});
