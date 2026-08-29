import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORT_ACCESS_MAX_WINDOW_MS,
  authorizeSupportAccess,
  prepareSupportAccessReason
} from "../../packages/domain/src/index.ts";
import type { SupportAccessGrant, SupportAccessRequest } from "../../packages/domain/src/index.ts";
import { redactPii } from "../../packages/security/src/index.ts";

// AF-66: "Any time a founder/operator looks at a specific tenant's data
// for support reasons, it's logged with a reason -- least-privilege, not
// silent access."

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const OPERATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OPERATOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-08-29T12:00:00.000Z");

function grant(overrides: Partial<SupportAccessGrant> = {}): SupportAccessGrant {
  return {
    grantId: "99999999-9999-4999-8999-999999999999",
    organizationId: ORG,
    operatorUserId: OPERATOR,
    reason: "investigating a stuck import reported by the customer",
    grantedByUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    grantedAt: "2026-08-29T11:00:00.000Z",
    expiresAt: "2026-08-29T13:00:00.000Z",
    ...overrides
  };
}

const REQUEST: SupportAccessRequest = {
  organizationId: ORG,
  operatorUserId: OPERATOR,
  entityType: "application",
  entityId: "44444444-4444-4444-8444-444444444444"
};

test("no grant means no access", () => {
  // The fail-closed default. There is deliberately no argument that means
  // "I already looked".
  assert.deepEqual(authorizeSupportAccess(undefined, REQUEST, NOW), {
    allowed: false,
    denialReason: "no_grant"
  });
});

test("a live, matching grant allows access and names itself", () => {
  const decision = authorizeSupportAccess(grant(), REQUEST, NOW);
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed ? decision.grantId : undefined, grant().grantId);
});

test("a grant for another tenant is refused as such, not as expired", () => {
  // Checked before expiry on purpose: a stale grant for tenant A used
  // against tenant B must not be reported as merely out of date, because
  // "renew it" would then look like the fix.
  const decision = authorizeSupportAccess(
    grant({ organizationId: OTHER_ORG, expiresAt: "2020-01-01T00:00:00.000Z" }),
    REQUEST,
    NOW
  );
  assert.equal(decision.allowed ? undefined : decision.denialReason, "grant_for_other_organization");
});

test("one operator cannot ride another operator's grant", () => {
  const decision = authorizeSupportAccess(grant({ operatorUserId: OTHER_OPERATOR }), REQUEST, NOW);
  assert.equal(decision.allowed ? undefined : decision.denialReason, "grant_for_other_operator");
});

test("a revoked grant is dead even if it has not expired", () => {
  const decision = authorizeSupportAccess(
    grant({ revokedAt: "2026-08-29T11:30:00.000Z" }),
    REQUEST,
    NOW
  );
  assert.equal(decision.allowed ? undefined : decision.denialReason, "grant_revoked");
});

test("a revocation timestamp in the future does not retroactively kill a live grant", () => {
  const decision = authorizeSupportAccess(grant({ revokedAt: "2026-08-29T12:30:00.000Z" }), REQUEST, NOW);
  assert.equal(decision.allowed, true);
});

test("a grant is dead AT its expiry instant, not one millisecond after", () => {
  // The boundary is the case someone will test, and off-by-one here means
  // access continues after the window everyone was told about.
  const expiresAt = "2026-08-29T12:00:00.000Z";
  assert.equal(
    authorizeSupportAccess(grant({ expiresAt }), REQUEST, new Date(expiresAt)).allowed,
    false
  );
  assert.equal(
    authorizeSupportAccess(grant({ expiresAt }), REQUEST, new Date(Date.parse(expiresAt) - 1)).allowed,
    true
  );
});

test("the maximum window is a day, so a forgotten grant is not a standing hole", () => {
  assert.equal(SUPPORT_ACCESS_MAX_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test("a reason naming a candidate is redacted before it is stored, using the REAL redactor", () => {
  // "Looking at jane@example.test's stuck upload" is the natural thing to
  // type, and it would quietly make the support log a candidate-data
  // store -- one that outlives retention, because it is an audit record.
  //
  // Deliberately the production redactPii rather than a stub: my first
  // version of this test used a hand-rolled /\S+@\S+/ and passed for the
  // wrong reason, because that pattern also swallows the trailing "'s".
  // A stub proves the plumbing; only the real one proves the pairing.
  const prepared = prepareSupportAccessReason("checking jane@example.test stuck upload", redactPii);
  assert.ok(!prepared.includes("jane@example.test"), `email survived redaction: ${prepared}`);
  assert.match(prepared, /checking .* stuck upload/, "the operator's actual reason must survive");
});

test("a phone number in a reason is redacted too, not just an email", () => {
  const prepared = prepareSupportAccessReason("customer called +1 555 010 4477 about this", redactPii);
  assert.ok(!prepared.includes("555 010 4477"), `phone survived redaction: ${prepared}`);
});

test("a reason that is only whitespace is rejected, not defaulted", () => {
  // A support access whose stated reason is blank is exactly the silent
  // access this ticket exists to prevent, wearing a row.
  for (const reason of ["", "   ", "\t\n"]) {
    assert.throws(
      () => prepareSupportAccessReason(reason, (value) => value),
      /at least one non-whitespace character/
    );
  }
});

test("a reason that becomes empty ONLY after redaction is also rejected", () => {
  // The case a length check on the input would miss: the operator typed
  // an email address and nothing else, so what survives redaction says
  // nothing about why.
  assert.throws(
    () => prepareSupportAccessReason("jane@example.test", () => "   "),
    /at least one non-whitespace character/
  );
});
