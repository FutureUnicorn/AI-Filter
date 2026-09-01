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

test("one organization cannot mint a public link for another's role", async () => {
  const observed = await observe();
  assert.match(observed.crossTenantRejection, /violates foreign key constraint/);
});
