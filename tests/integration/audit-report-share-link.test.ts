import assert from "node:assert/strict";
import test from "node:test";

import { assertAuditReportShareLinkSecurity } from "../../packages/db/src/index.ts";

// AF-90. One probe builds live, expired, revoked and unknown links against
// the real schema; the tests below read its observations.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

async function observe(): Promise<Awaited<ReturnType<typeof assertAuditReportShareLinkSecurity>>> {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the constraints and append-only triggers for real. See README.md."
    );
  }
  return assertAuditReportShareLinkSecurity(DATABASE_URL);
}

test("a live link serves the report", async () => {
  const observed = await observe();
  assert.equal(observed.liveResolution, "available");
});

test("expired, revoked and unknown are each refused, and distinguished only internally", async () => {
  const observed = await observe();
  assert.equal(observed.expiredResolution, "expired");
  assert.equal(observed.revokedResolution, "revoked");
  assert.equal(observed.unknownResolution, "not_found");
});

test("all three failures are indistinguishable to the caller", async () => {
  // The load-bearing property, and the one that is invisible in the happy
  // path: three different internal reasons must produce one response.
  const observed = await observe();
  assert.deepEqual(observed.distinctFailureBodies.length, 1);
  assert.deepEqual(observed.distinctFailureStatuses, [404]);
});

test("a disclosure is logged exactly once, and only when the report was served", async () => {
  // The log has to mean one thing. If refused attempts were recorded here
  // too, "this report was seen" and "someone knocked" would be the same
  // row, and the log would be useless as evidence later.
  const observed = await observe();
  assert.equal(observed.liveViewCount, 1);
  assert.equal(observed.refusedViewCount, 0);
});

test("re-revoking does not rewrite when the first revocation happened", async () => {
  // That timestamp is the fact anyone would later be asking about.
  const observed = await observe();
  assert.equal(observed.revokedAtUnchangedOnSecondRevoke, true);
});

test("revoking a role kills its remaining links and leaves other roles alone", async () => {
  // "The pilot is over" is role-wide; it must not reach across roles.
  const observed = await observe();
  assert.ok(observed.roleWideRevokedCount >= 1);
  assert.equal(observed.otherRoleLinkStillLive, true);
});

test("the view log cannot be rewritten", async () => {
  const observed = await observe();
  assert.match(observed.viewsUpdateRejection, /append-only: UPDATE is not allowed/);
});

test("a link cannot be minted beyond the expiry ceiling", async () => {
  // Enforced at the database, not only in the domain helper, so a direct
  // SQL writer cannot mint a link that outlives the pilot.
  const observed = await observe();
  assert.match(observed.expiryCeilingRejection, /audit_report_share_links_expiry_within_ceiling/);
});

test("a future-dated created_at cannot stretch the 180-day ceiling past wall time", async () => {
  // REV-003. The lifetime was decided (30/180); a writable created_at meant
  // the ceiling did not bind to real elapsed time. Pinning created_at to
  // the database clock makes the CHECK judge wall time.
  const observed = await observe();
  assert.match(
    observed.futureDatedCreatedAtRejection,
    /audit_report_share_links_expiry_within_ceiling/
  );
});

test("one organization cannot mint a public link for another's role", async () => {
  const observed = await observe();
  assert.match(observed.crossTenantRejection, /violates foreign key constraint/);
});

test("a report that does not match the link organization and role is refused", async () => {
  // REV-002. The composite FK proves the link columns are a real role pair;
  // without this check the JSON blob can serve another tenant on an
  // unauthenticated URL.
  const observed = await observe();
  assert.match(observed.mismatchedReportRejection, /report is for organization/);
});

test("a viewed share link blocks deleting its role; an unviewed link does not", async () => {
  // REV-004. Pins today's ON DELETE RESTRICT behaviour. Soft-delete versus
  // cascade-with-flag is a product decision; this only records what the
  // schema does now so a future change is visible.
  const observed = await observe();
  assert.match(observed.viewedLinkBlocksRoleDelete, /foreign key|restrict/i);
  assert.equal(observed.unviewedLinkAllowsRoleDelete, true);
});

// REV-006. Revocation is described as "per-link, immediate", which is the
// whole point of "I sent it to the wrong person". The resolve read the row
// without a lock, so under READ COMMITTED it neither blocked on nor
// re-checked an in-flight revoke: a resolve beginning microseconds earlier
// still returned the full report after the operator believed the link was
// dead. The link is unauthenticated, so there is no second lookup to catch
// it.

test("a revoke landing mid-resolve is not raced past", async () => {
  const observations = await observe();
  // The lock is the mechanism: the resolve must wait rather than read a
  // stale snapshot. If it settles while the revoke is still uncommitted,
  // it never waited, which is the defect regardless of what it returned.
  assert.equal(
    observations.resolveBlockedOnRevoke,
    true,
    "the resolve must block behind an uncommitted revoke instead of reading past it"
  );
  assert.notEqual(
    observations.raceResolutionStatus,
    "available",
    "a link revoked before the resolve committed must never serve its report"
  );
  // "unavailable", not "revoked". This endpoint collapses revoked, expired
  // and unknown into one indistinguishable answer so an unauthenticated
  // caller cannot use it as an oracle for which tokens ever existed.
  // Asserting "revoked" here would quietly require that property be broken.
  assert.equal(observations.raceResolutionStatus, "unavailable");
  // The public status is uniform; the internal reason is what actually
  // diagnoses it. Both matter: a caller must not be able to tell a revoked
  // link from an expired or unknown one, while the system must still know.
  assert.equal(
    observations.raceResolutionReason,
    observations.revokedResolution,
    "the raced revoke must be diagnosed exactly as an ordinary revoked link"
  );
});
