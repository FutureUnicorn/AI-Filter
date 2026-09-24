import assert from "node:assert/strict";
import test from "node:test";

import { assertAuditReportShareLinkActorMembership } from "../../packages/db/src/index.ts";

// REV-001 / AF-90. An audit-report share link is an accountability record
// (who disclosed a tenant report, who revoked that disclosure). The actor
// columns must name a member of that organization. This is the same
// standing rule used by evidentiary actor columns, not a claim that every
// user_id column in the schema is membership-scoped.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

async function observe(): Promise<
  Awaited<ReturnType<typeof assertAuditReportShareLinkActorMembership>>
> {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the foreign keys for real. See README.md."
    );
  }
  return assertAuditReportShareLinkActorMembership(DATABASE_URL);
}

test("createAuditReportShareLink refuses a created_by_user_id with no membership in the organization", async () => {
  const observed = await observe();
  assert.equal(observed.memberCreateSucceeded, true, "member control must still be able to mint");
  assert.match(
    observed.createByOutsiderRejection,
    /foreign key|memberships/i,
    `outsider create must be refused by the schema; got ${JSON.stringify(observed.createByOutsiderRejection)}`
  );
});

test("revokeAuditReportShareLinks refuses a revoked_by_user_id with no membership in the organization", async () => {
  const observed = await observe();
  assert.equal(observed.memberCreateSucceeded, true, "member control must still be able to mint");
  assert.match(
    observed.revokeByOutsiderRejection,
    /foreign key|memberships/i,
    `outsider revoke must be refused by the schema; got ${JSON.stringify(observed.revokeByOutsiderRejection)}`
  );
});
