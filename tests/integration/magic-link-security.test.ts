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

test("createConsoleMagicLinkEmailSender does not leak the recipient or raw token", async (t) => {
  const logMock = t.mock.method(console, "log", () => undefined);
  const stderrMock = t.mock.method(process.stderr, "write", () => true);
  const sender = createConsoleMagicLinkEmailSender("development");
  await sender.sendMagicLink({ email: "user@acme.test", link: "https://example.test/verify?token=abc" });
  const dumped = [
    ...logMock.mock.calls.map((call) => String(call.arguments[0])),
    ...stderrMock.mock.calls.map((call) => String(call.arguments[0]))
  ].join("\n");
  assert.equal(dumped.includes("user@acme.test"), false);
  assert.equal(dumped.includes("token=abc"), false);
  assert.equal(dumped.includes("token=[REDACTED]"), true);
});

test("every token parameter is redacted, not just the first", async (t) => {
  // A duplicated query parameter is well-formed and nothing rejects it.
  // Before the `g` flag, the second token printed to the terminal in full
  // -- a redaction that stops at the first match leaks on every input its
  // author did not picture.
  const stderrMock = t.mock.method(process.stderr, "write", () => true);
  const sender = createConsoleMagicLinkEmailSender("development");
  await sender.sendMagicLink({
    email: "user@acme.test",
    link: "https://example.test/verify?a=1&token=FIRST_SECRET&b=2&token=SECOND_SECRET&c=3"
  });
  const written = stderrMock.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.doesNotMatch(written, /FIRST_SECRET/, "the first token must not reach the terminal");
  assert.doesNotMatch(written, /SECOND_SECRET/, "the second token must not reach the terminal either");
  assert.equal(written.match(/token=\[REDACTED\]/g)?.length, 2, "both parameters must be redacted");
});
