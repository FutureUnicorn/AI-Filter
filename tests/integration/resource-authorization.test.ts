import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import type { Membership } from "../../packages/domain/src/index.ts";
import {
  authorizeResourceAccess,
  resourceAuthorizationErrorResponse
} from "../../packages/security/src/index.ts";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";

function membership(organizationId: string, role: Membership["role"]): Membership {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    membershipId: "33333333-3333-4333-8333-333333333333",
    organizationId,
    userId: "44444444-4444-4444-8444-444444444444",
    role,
    createdAt: "2026-08-21T12:00:00.000Z"
  };
}

test("a recruiter membership in the requested org authorizes a recruiter capability", () => {
  const result = authorizeResourceAccess([membership(orgA, "recruiter")], orgA, "review_candidates");
  assert.deepEqual(result, { outcome: "authorized", role: "recruiter" });
});

test("a client-supplied organizationId the caller has no membership in is never trusted", () => {
  // The caller only has a membership in orgA; orgB is not theirs, whether or not orgB even exists.
  const result = authorizeResourceAccess([membership(orgA, "owner")], orgB, "review_candidates");
  assert.deepEqual(result, { outcome: "no_membership" });
});

test("having no memberships at all yields no_membership, not a crash", () => {
  const result = authorizeResourceAccess([], orgA, "review_candidates");
  assert.deepEqual(result, { outcome: "no_membership" });
});

test("a real membership without the capability is insufficient_capability, not no_membership", () => {
  const result = authorizeResourceAccess([membership(orgA, "auditor")], orgA, "review_candidates");
  assert.deepEqual(result, { outcome: "insufficient_capability", role: "auditor" });
});

test("no_membership maps to not_found so an org's existence is never confirmed to an outsider", () => {
  const response = resourceAuthorizationErrorResponse({ outcome: "no_membership" }, "req_x");
  assert.equal(response?.status, 404);
  assert.equal(response?.body.error.code, "not_found");
});

test("insufficient_capability maps to forbidden, and names the actual role", () => {
  const requestId = "req_x";
  const response = resourceAuthorizationErrorResponse(
    { outcome: "insufficient_capability", role: "auditor" },
    requestId
  );
  assert.equal(response?.status, 403);
  assert.equal(response?.body.error.code, "forbidden");
  assert.match(response?.body.error.message ?? "", /auditor/);
});

test("authorized yields no error response", () => {
  const response = resourceAuthorizationErrorResponse({ outcome: "authorized", role: "owner" }, "req_x");
  assert.equal(response, undefined);
});
