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

test("createConsoleMagicLinkEmailSender keeps the credential out of the LOG, not out of the terminal", async (t) => {
  // Rewritten. This asserted that the token never reached stderr either,
  // which made the printed link unopenable -- the same outcome as the
  // silent no-op this adapter was written to replace. The boundary that
  // matters is the retained log stream: a credential that survives in
  // shipped logs is the threat, one that appears for a moment in the
  // terminal of the developer who just requested it is the feature.
  const logMock = t.mock.method(console, "log", () => undefined);
  const stderrMock = t.mock.method(process.stderr, "write", () => true);
  const sender = createConsoleMagicLinkEmailSender("development");
  await sender.sendMagicLink({ email: "user@acme.test", link: "https://example.test/verify?token=abc" });

  const logged = logMock.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  assert.equal(logged.includes("token=abc"), false, "the structured log must never carry the credential");
  assert.equal(logged.includes("user@acme.test"), false, "nor the recipient");

  const written = stderrMock.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  assert.equal(written.includes("token=abc"), true, "the developer must be able to open the link");
  assert.equal(written.includes("user@acme.test"), false, "the recipient is still redacted; nothing needs it");
});

test("a link with duplicated token parameters is printed intact, not partially mangled", async (t) => {
  // Rewritten alongside the test above. It previously asserted BOTH
  // tokens were redacted -- a fix I made for a real bug in a redaction
  // that should not have been there at all. With the redaction gone the
  // bug is gone with it, and what matters now is that an unusual but
  // well-formed link is not silently altered on its way to the terminal:
  // a developer debugging a duplicated parameter needs to see it.
  const stderrMock = t.mock.method(process.stderr, "write", () => true);
  const sender = createConsoleMagicLinkEmailSender("development");
  const link = "https://example.test/verify?a=1&token=FIRST_SECRET&b=2&token=SECOND_SECRET&c=3";
  await sender.sendMagicLink({ email: "user@acme.test", link });
  const written = stderrMock.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.ok(written.includes(link), "the link reaches the terminal exactly as issued");
  assert.doesNotMatch(written, /\[REDACTED\]/u, "nothing in the link is rewritten any more");
});
