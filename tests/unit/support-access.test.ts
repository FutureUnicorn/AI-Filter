import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORT_ACCESS_MAX_WINDOW_MS,
  SUPPORT_ACCESS_REASON_CODES,
  authorizeSupportAccess,
  validateSupportAccessReason
} from "../../packages/domain/src/index.ts";
import type { SupportAccessGrant, SupportAccessRequest } from "../../packages/domain/src/index.ts";

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
    reasonCode: "stuck_upload",
    ticketReference: "AF-101",
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

// ---- REV-002: the redaction never covered the common case ----
//
// Both reviewers found this independently. The tests here used to pass
// an email and a phone number through redactPii and assert they were
// masked, which is true and is not the question. A support note says
// "looking at Jane Doe's stuck upload", and a name has no shape for a
// redactor to match. The retention exemption on support_access_grants
// rested on that redaction, in a table that rejects DELETE and rejects
// any UPDATE to the reason, so the name went in and could not come out.
//
// The free text is gone rather than better filtered. These tests now
// pin that, including the demonstration that the old approach was not
// salvageable.

// The demonstration that redactPii leaves a name untouched lives in
// tests/integration/support-access-integrity.test.ts, not here.
// packages/security imports @signal-audit/contracts by package specifier,
// so anything reaching redactPii needs built dist, and test:unit:ts does
// not build. See the architecture guard added alongside this.

test("a grant carries no field a candidate's name can be written into", () => {
  // The structural claim the retention exemption now rests on, asserted
  // over the object rather than over one column: every value on a grant
  // is a uuid, a reason code from a closed set, a ticket key, or a
  // timestamp. None of them is free text.
  const values = Object.entries(grant());
  for (const [field, value] of values) {
    if (field === "reasonCode") {
      assert.ok((SUPPORT_ACCESS_REASON_CODES as readonly string[]).includes(value as string));
      continue;
    }
    if (field === "ticketReference") {
      assert.match(value as string, /^[A-Z][A-Z0-9]*-[0-9]+$/u);
      continue;
    }
    assert.match(
      value as string,
      /^[0-9a-fA-F-]+$|^\d{4}-\d{2}-\d{2}T/u,
      `${field} is neither an identifier nor a timestamp, so it may be free text`
    );
  }
});

test("a reason code outside the closed set is refused", () => {
  assert.throws(
    () =>
      validateSupportAccessReason({
        reasonCode: "looking into a stuck import" as never,
        ticketReference: "AF-101"
      }),
    /must be one of/
  );
});

test("a ticket reference loose enough to hold a sentence is refused", () => {
  // The way this change could be undone without anyone editing it: put
  // the narrative in the other column. The pattern is what stops that,
  // so it gets the name case explicitly.
  for (const reference of ["Jane Doe stuck upload", "af-101", "AF101", "", "AF-", "AF-101 Jane"]) {
    assert.throws(
      () => validateSupportAccessReason({ reasonCode: "stuck_upload", ticketReference: reference }),
      /must look like ABC-123/,
      `"${reference}" must not be accepted as a ticket reference`
    );
  }
});

test("every declared reason code is actually accepted", () => {
  // So the validator cannot pass the tests above by refusing everything.
  for (const reasonCode of SUPPORT_ACCESS_REASON_CODES) {
    validateSupportAccessReason({ reasonCode, ticketReference: "AF-101" });
  }
});

// ---- REV-003: the time checks were the one place this failed open ----

test("an expiry that does not parse denies rather than falling through to allowed", () => {
  // Date.parse returns NaN, every comparison with NaN is false, and the
  // old form skipped its own denial and reached `allowed: true`. A grant
  // with a corrupt expiry was a grant with no expiry.
  assert.deepEqual(authorizeSupportAccess(grant({ expiresAt: "not-a-date" }), REQUEST, NOW), {
    allowed: false,
    denialReason: "grant_malformed"
  });
});

test("a revocation stored as an unparseable value is treated as a revocation, not as absent", () => {
  // The only safe reading of "someone wrote something into revoked_at".
  for (const revokedAt of ["", "   ", "yesterday"]) {
    assert.deepEqual(
      authorizeSupportAccess(grant({ revokedAt }), REQUEST, NOW),
      { allowed: false, denialReason: "grant_malformed" },
      `revokedAt ${JSON.stringify(revokedAt)} must not be ignored`
    );
  }
});

test("an invalid clock denies, because now is an argument and therefore input", () => {
  // The same hole one level up. With an Invalid Date, every comparison
  // in the function is false no matter what the grant says.
  assert.deepEqual(authorizeSupportAccess(grant(), REQUEST, new Date("nonsense")), {
    allowed: false,
    denialReason: "grant_malformed"
  });
});

test("a live grant with well-formed timestamps is still allowed", () => {
  // The control for the three above: they must not be passing because
  // the function now denies everything.
  assert.deepEqual(authorizeSupportAccess(grant(), REQUEST, NOW), {
    allowed: true,
    grantId: "99999999-9999-4999-8999-999999999999"
  });
});
