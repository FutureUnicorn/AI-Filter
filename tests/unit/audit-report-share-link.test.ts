import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARE_LINK_DEFAULT_DAYS,
  SHARE_LINK_MAX_DAYS,
  SHARE_LINK_UNAVAILABLE_MESSAGE,
  computeShareLinkExpiry,
  renderShareLinkResolution,
  shareLinkDisclosureNotice
} from "../../packages/domain/src/index.ts";
import type { ShareLinkResolution } from "../../packages/domain/src/index.ts";
import {
  generateAuditReportShareToken,
  hashAuditReportShareToken
} from "../../packages/security/src/index.ts";

// AF-90. The endpoint is unauthenticated by definition, so the properties
// worth asserting are the negative ones -- what a caller cannot learn, and
// what a link stops doing on its own.

test("a share link always expires, and cannot outlive the ceiling", () => {
  // A pilot ends. A link that outlives it is the failure this ticket names,
  // so there is no never-expires option to test for.
  const created = new Date("2026-09-01T00:00:00.000Z");
  assert.equal(computeShareLinkExpiry(created), "2026-10-01T00:00:00.000Z");
  assert.equal(SHARE_LINK_DEFAULT_DAYS, 30);
  assert.throws(() => computeShareLinkExpiry(created, SHARE_LINK_MAX_DAYS + 1), /at most 180 days/);
  assert.throws(() => computeShareLinkExpiry(created, 0), /at least one/);
  assert.throws(() => computeShareLinkExpiry(created, 1.5), /whole number of days/);
});

test("every failure renders identically, so the endpoint is not an oracle", () => {
  // Telling an unauthenticated caller that a token was "expired" or
  // "revoked" rather than "not found" confirms it existed, which turns
  // guessing into a two-step attack: enumerate to find real tokens, then
  // look for a leaked-but-live one.
  const failures: ShareLinkResolution[] = [
    { status: "unavailable", internalReason: "not_found" },
    { status: "unavailable", internalReason: "expired" },
    { status: "unavailable", internalReason: "revoked" }
  ];
  const rendered = failures.map((f) => renderShareLinkResolution(f));
  assert.equal(new Set(rendered.map((r) => r.body)).size, 1);
  assert.equal(new Set(rendered.map((r) => r.httpStatus)).size, 1);
  assert.equal(rendered[0]?.httpStatus, 404);
  assert.equal(rendered[0]?.body, SHARE_LINK_UNAVAILABLE_MESSAGE);
});

test("the rendered failure never leaks the internal reason", () => {
  // The reason is kept for operators -- a revoked link being retried is
  // worth seeing -- so the risk is that it gets passed through "just for
  // debugging". Asserted directly rather than trusted.
  for (const reason of ["not_found", "expired", "revoked"] as const) {
    const { body } = renderShareLinkResolution({ status: "unavailable", internalReason: reason });
    assert.doesNotMatch(body, new RegExp(reason, "iu"));
  }
  assert.doesNotMatch(SHARE_LINK_UNAVAILABLE_MESSAGE, /revok|expir|not found|invalid token/iu);
});

test("share tokens carry at least the 128 bits OWASP asks of a reference token", () => {
  // base64url of 32 random bytes: 256 bits of entropy, 43 characters with
  // no padding. Asserted on the encoding rather than on a byte count,
  // because the encoding is what actually reaches the URL.
  const { token, tokenHash } = generateAuditReportShareToken();
  assert.equal(token.length, 43);
  assert.match(token, /^[A-Za-z0-9_-]+$/u, "must be URL-safe with no padding");
  const bitsOfEntropy = 32 * 8;
  assert.ok(bitsOfEntropy >= 128);
  assert.equal(tokenHash, hashAuditReportShareToken(token));
  assert.match(tokenHash, /^[0-9a-f]{64}$/u);
});

test("two generated tokens differ, so the generator is not a constant", () => {
  // The control for the test above: a fixed token would satisfy every
  // shape assertion there.
  const seen = new Set(Array.from({ length: 50 }, () => generateAuditReportShareToken().token));
  assert.equal(seen.size, 50);
});

test("the raw token is not recoverable from what gets stored", () => {
  const { token, tokenHash } = generateAuditReportShareToken();
  assert.notEqual(tokenHash, token);
  assert.ok(!tokenHash.includes(token));
});

test("the disclosure notice states the reconstruction-key caveat", () => {
  // A leaked link exposes role-level metrics, not named candidates -- but
  // the sample seed lets anyone who already holds the application list work
  // out which ones were sampled. An employer deciding whether to forward
  // the link should be deciding with that in front of them.
  const notice = shareLinkDisclosureNotice();
  assert.match(notice, /does not name candidates/iu);
  assert.match(notice, /seed/iu);
  assert.match(notice, /which ones were sampled/iu);
});
