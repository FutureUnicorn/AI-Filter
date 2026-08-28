import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITIES, CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import type { Membership, MembershipRole } from "../../packages/domain/src/index.ts";
import { assertMembershipsTenantIsolation } from "../../packages/db/src/index.ts";
import {
  authorizeResourceAccess,
  resourceAuthorizationErrorResponse
} from "../../packages/security/src/index.ts";

// See docs/architecture/cross-tenant-testing.md for the gate this suite
// establishes: this proves the authorization mechanism itself rejects
// cross-tenant access in every shape available today. It cannot yet
// prove any real endpoint calls it correctly, because none exist.

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const orgC = "33333333-3333-4333-8333-333333333333";
const callerUserId = "55555555-5555-4555-8555-555555555555";

function membership(organizationId: string, role: MembershipRole): Membership {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    membershipId: "44444444-4444-4444-8444-444444444444",
    organizationId,
    userId: callerUserId,
    role,
    createdAt: "2026-08-21T12:00:00.000Z"
  };
}

test("IDOR: a caller with no membership anywhere is rejected for any organization", () => {
  const result = authorizeResourceAccess([], orgA, "view_audit_reports", callerUserId);
  assert.deepEqual(result, { outcome: "no_membership" });
});

test("IDOR: owner in one organization has zero standing in a sibling organization", () => {
  // The strongest role there is (owner) in Org A must not leak any access to Org B.
  const memberships = [membership(orgA, "owner")];
  for (const capability of CAPABILITIES) {
    const result = authorizeResourceAccess(memberships, orgB, capability, callerUserId);
    assert.deepEqual(result, { outcome: "no_membership" }, `owner-in-A should not reach ${capability} in B`);
  }
});

test("IDOR: a forged organizationId with no matching membership is rejected identically to a real sibling org", () => {
  const memberships = [membership(orgA, "owner")];
  const forgedOrgResult = authorizeResourceAccess(memberships, orgC, "review_candidates", callerUserId);
  const siblingOrgResult = authorizeResourceAccess(memberships, orgB, "review_candidates", callerUserId);
  assert.deepEqual(forgedOrgResult, { outcome: "no_membership" });
  assert.deepEqual(forgedOrgResult, siblingOrgResult);
});

test("a user's roles across organizations are fully independent: each check uses only that org's own row", () => {
  const memberships = [membership(orgA, "owner"), membership(orgB, "auditor")];

  const inOrgA = authorizeResourceAccess(memberships, orgA, "review_candidates", callerUserId);
  assert.deepEqual(inOrgA, { outcome: "authorized", role: "owner" });

  // Same capability, same user, but Org B's role (auditor) does not have it --
  // the Org A membership must not be consulted at all for an Org B request.
  const inOrgB = authorizeResourceAccess(memberships, orgB, "review_candidates", callerUserId);
  assert.deepEqual(inOrgB, { outcome: "insufficient_capability", role: "auditor" });
});

test("write-shaped capability (record_decision) is rejected cross-tenant exactly like a read-shaped one", () => {
  const memberships = [membership(orgA, "recruiter")];
  const write = authorizeResourceAccess(memberships, orgB, "record_decision", callerUserId);
  const read = authorizeResourceAccess(memberships, orgB, "view_audit_reports", callerUserId);
  assert.deepEqual(write, { outcome: "no_membership" });
  assert.deepEqual(read, { outcome: "no_membership" });
});

test("every cross-tenant no_membership rejection reaches the API as 404, never 403", () => {
  const memberships = [membership(orgA, "owner")];
  const authorization = authorizeResourceAccess(memberships, orgB, "access_admin_settings", callerUserId);
  const response = resourceAuthorizationErrorResponse(authorization, "req_x");
  assert.equal(response?.status, 404);
  assert.equal(response?.body.error.code, "not_found");
  // Specifically not 403/forbidden: that would confirm Org B exists to a caller who has no relationship to it.
  assert.notEqual(response?.status, 403);
});

test("a genuine same-tenant capability shortfall is 403, distinct from the cross-tenant 404 case", () => {
  const memberships = [membership(orgA, "auditor")];
  const authorization = authorizeResourceAccess(memberships, orgA, "review_candidates", callerUserId);
  const response = resourceAuthorizationErrorResponse(authorization, "req_x");
  assert.equal(response?.status, 403);
  assert.equal(response?.body.error.code, "forbidden");
});

test("memberships RLS rejects cross-tenant reads and writes for a non-superuser role", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test exercises " +
        "packages/db/migrations/0004_tenant_scoped_rls.sql for real. Locally: run `pnpm dev:infra`, then set it " +
        "to postgresql://signal_audit_local:local-only-password@localhost:5432/signal_audit_local (see README.md)."
    );
  }
  await assertMembershipsTenantIsolation(databaseUrl);
});
