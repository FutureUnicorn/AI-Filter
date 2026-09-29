import assert from "node:assert/strict";
import test from "node:test";

import { assertSupportAccessIntegrity } from "../../packages/db/src/index.ts";
import { redactPii } from "../../packages/security/src/index.ts";

// AF-66. The domain refuses support access without a live grant; these
// prove the database refuses the grants that should never exist in the
// first place. A rule enforced only in the application layer is a rule
// that a direct psql session, a migration script or a future endpoint
// can walk around.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

async function rejections(): Promise<Record<string, string>> {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string");
  }
  return assertSupportAccessIntegrity(DATABASE_URL);
}

test("an operator cannot grant themselves access to a tenant", async () => {
  // The whole point of naming a second person is that someone else knew.
  // Self-granted access is not a control, it is a formality.
  const found = await rejections();
  assert.match(found["self_granted"] ?? "", /support_access_grants_not_self_granted/);
});

// ---- REV-002: the redaction never covered the common case ----
//
// Both reviewers found this independently. The grant's reason was free
// text redacted through redactPii on the way in, and the retention
// exemption on support_access_grants rested on that redaction making it
// PII-free. It does not cover names, and a support note is usually
// about a person.
//
// These tests live here rather than in tests/unit because reaching
// redactPii means loading packages/security, which imports
// @signal-audit/contracts by package specifier and therefore needs built
// dist. test:unit:ts does not build.

test("the production redactor leaves a candidate's name untouched, which is why the free text went", () => {
  // The negative result that motivates the whole change, kept as a test
  // so nobody re-introduces a free-text column believing redactPii
  // covers it. Deliberately the real redactPii, not a stub: an earlier
  // version of the tests here used a hand-rolled pattern and proved only
  // the plumbing.
  const note = "Looking at Jane Doe's stuck upload";
  assert.equal(redactPii(note), note, "if this ever starts masking names, the finding changes shape");
  const richer = "candidate Priya Raman, 12 Baker St, DOB 1990-04-02";
  assert.equal(redactPii(richer), richer);
});

test("the database refuses a reason code outside the closed set", () => {
  // What replaced the whitespace-reason case. There is no free-text
  // reason left to be blank, so the shapes that have to be refused are a
  // code nobody declared and a ticket reference loose enough to carry
  // the sentence the column was relieved of.
  return rejections().then((found) => {
    assert.match(found["reason_code_outside_the_closed_set"] ?? "", /reason_code_check/);
  });
});

test("the database refuses a ticket reference that could hold a candidate's name", () => {
  return rejections().then((found) => {
    assert.match(found["ticket_reference_holding_free_text"] ?? "", /ticket_reference_check/);
  });
});

test("a grant longer than a day is refused", async () => {
  // An unbounded grant is indistinguishable from permanent access, and
  // nobody remembers to revoke.
  const found = await rejections();
  assert.match(found["window_too_long"] ?? "", /support_access_grants_bounded_window/);
});

test("a grant that expires before it starts is refused", async () => {
  const found = await rejections();
  assert.match(found["expires_before_grant"] ?? "", /support_access_grants_expires_after_grant/);
});

test("an access event cannot cite a grant issued for a different tenant", async () => {
  // The composite key. Without it an event could name tenant B while
  // pointing at a grant that only ever authorised tenant A -- and the
  // access log for B would show an authorisation that does not exist.
  const found = await rejections();
  assert.match(found["event_cites_other_org_grant"] ?? "", /violates foreign key constraint/);
});

test("an access event with a blank entity id is refused", async () => {
  const found = await rejections();
  assert.match(found["event_blank_entity_id"] ?? "", /entity_id/);
});

test("access events cannot be deleted or edited afterwards", async () => {
  // The one person with a motive to remove a row is the person the row is
  // about.
  const found = await rejections();
  assert.match(found["event_delete"] ?? "", /append-only: DELETE is not allowed/);
  assert.match(found["event_update"] ?? "", /append-only: UPDATE is not allowed/);
});

test("a grant's reason and window cannot be amended after the fact", async () => {
  // Amendable terms would let the record be rewritten to match whatever
  // was actually done, which is worse than no record.
  const found = await rejections();
  assert.match(found["grant_reason_amended"] ?? "", /only revoked_at may be updated/);
  assert.match(found["grant_window_extended"] ?? "", /only revoked_at may be updated/);
  assert.match(found["grant_delete"] ?? "", /DELETE is not allowed/);
});

test("revocation is permitted once and cannot be undone", async () => {
  // Revoking early is a safety property, so grants are not fully
  // append-only. Un-revoking would turn that safety valve into a way to
  // reopen access without a new authorisation.
  const found = await rejections();
  assert.match(found["revocation_undone"] ?? "", /revoked_at cannot be changed once set/);
});

// ---- REV-001: only platform operators can be named ----

test("an ordinary customer account cannot be named as the operator on a grant", async () => {
  // users is a single global table, so a bare REFERENCES users let any
  // customer's recruiter be the "operator", and two colluding accounts could
  // grant each other cross-tenant access past every other constraint.
  const found = await rejections();
  assert.match(
    found["operator_not_allowlisted"] ?? "",
    /support_access_grants_operator_is_platform_operator/,
    "the refusal must come from the platform_operators allowlist, not from some other constraint"
  );
});

test("an operator cannot be authorised by an ordinary account, so dual custody means two operators", async () => {
  // An operator plus their own spare customer account would otherwise pass
  // not_self_granted: a control one person can satisfy alone is not dual
  // custody.
  const found = await rejections();
  assert.match(found["grantor_not_allowlisted"] ?? "", /support_access_grants_grantor_is_platform_operator/);
});

test("an access event must name the operator its grant was issued to", async () => {
  // Enforced in the domain by authorizeSupportAccess, which a direct writer
  // walks around. The composite key makes it a database fact.
  const found = await rejections();
  assert.match(found["event_operator_not_grant_operator"] ?? "", /support_access_events_operator_matches_grant/);
});

// ---- REV-001: offboarding ----

test("a revoked operator cannot be named on a new grant, as operator or as grantor", async () => {
  // An allowlist nobody can be removed from is not least privilege.
  const found = await rejections();
  assert.match(found["revoked_operator_new_grant"] ?? "", /operator .* has been revoked from platform_operators/);
  assert.match(found["revoked_grantor_new_grant"] ?? "", /grantor .* has been revoked from platform_operators/);
});

test("revoking an operator leaves grants issued before they left untouched and usable", async () => {
  // Leaving does not retroactively unauthorise access that was legitimate
  // when it happened, and history must not change. The probe throws if the
  // earlier grant's row differs at all after the revocation.
  const found = await rejections();
  assert.equal(found["accepted:event_under_grant_issued_before_leaving"], "accepted");
});

test("the revocation check works from a session whose search_path is not the schema", async () => {
  // The application schema-qualifies its tables and leaves search_path
  // alone, so a trigger resolving platform_operators through the caller's
  // search_path would refuse every real grant with "relation does not exist".
  const found = await rejections();
  assert.equal(found["accepted:grant_inserted_with_another_search_path"], "accepted");
});

// ---- REV-004: a cascade into an append-only table only changes the error ----

test("deleting an organization is refused by the foreign key, not by an append-only trigger", async () => {
  // Both organization_id columns carried ON DELETE CASCADE. The delete
  // was refused either way, so nothing was ever at risk -- but a cascade
  // issues a DELETE against a table whose trigger rejects DELETE, so the
  // person offboarding a tenant got "support_access_grants is
  // append-only", naming a table they had not mentioned, instead of a
  // foreign key violation naming organizations.
  //
  // 0006 hit this on audit_events and 0016 documents it at length; this
  // holds 0022 to the same convention as the evidence_outcomes probe.
  const found = await rejections();
  const refusal = found["organization_deleted"] ?? "";
  assert.match(refusal, /violates foreign key constraint/);
  assert.doesNotMatch(
    refusal,
    /append-only/,
    "a cascade reached an append-only table, which reports the wrong table to whoever is offboarding"
  );
  // The SQLSTATE, not only the prose: 23503 is a referential violation
  // and P0001 is a RAISE EXCEPTION from a trigger, and the distinction is
  // the entire finding.
  assert.equal(found["organization_deleted:sqlstate"], "23503");
});
