import assert from "node:assert/strict";
import test from "node:test";

import { createSessionToken, verifySessionToken } from "../../packages/security/src/index.ts";

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);

test("a freshly created session token verifies to the same userId", () => {
  const token = createSessionToken("user-1", SECRET);
  const result = verifySessionToken(token, SECRET);
  assert.deepEqual(result, { outcome: "valid", userId: "user-1" });
});

test("a token signed with a different secret is invalid", () => {
  const token = createSessionToken("user-1", SECRET);
  assert.deepEqual(verifySessionToken(token, OTHER_SECRET), { outcome: "invalid" });
});

test("a token past its expiry is reported expired, not invalid", () => {
  const issuedAt = new Date("2026-01-01T00:00:00.000Z");
  const token = createSessionToken("user-1", SECRET, issuedAt, 1_000);
  const afterExpiry = new Date(issuedAt.getTime() + 2_000);
  assert.deepEqual(verifySessionToken(token, SECRET, afterExpiry), { outcome: "expired" });
});

test("a tampered payload is rejected even if the signature segment is untouched", () => {
  const token = createSessionToken("user-1", SECRET);
  const [payload, signature] = token.split(".");
  const tamperedPayload = Buffer.from(
    JSON.stringify({ userId: "someone-else", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 }),
    "utf8"
  ).toString("base64url");
  assert.notEqual(tamperedPayload, payload);
  assert.deepEqual(verifySessionToken(`${tamperedPayload}.${signature}`, SECRET), { outcome: "invalid" });
});

test("malformed tokens (wrong shape, garbage) are rejected, not thrown", () => {
  assert.deepEqual(verifySessionToken("not-a-token", SECRET), { outcome: "invalid" });
  assert.deepEqual(verifySessionToken("a.b.c", SECRET), { outcome: "invalid" });
  assert.deepEqual(verifySessionToken("", SECRET), { outcome: "invalid" });
});
