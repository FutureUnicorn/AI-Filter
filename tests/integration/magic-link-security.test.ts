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

test("createConsoleMagicLinkEmailSender does not log the recipient or the raw token", async (t) => {
  const logMock = t.mock.method(console, "log", () => undefined);
  const sender = createConsoleMagicLinkEmailSender();
  await sender.sendMagicLink({ email: "user@acme.test", link: "https://example.test/verify?token=abc" });
  const dumped = logMock.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  assert.equal(dumped.includes("user@acme.test"), false);
  assert.equal(dumped.includes("token=abc"), false);
});
