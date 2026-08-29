import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import type { Membership } from "../../packages/domain/src/index.ts";
import { apiErrorBodySchema } from "../../packages/contracts/src/index.ts";
import {
  authorizeResourceAccess,
  resourceAuthorizationErrorResponse
} from "../../packages/security/src/index.ts";

// A real request id. requestId was used here until AF-13 made buildApiError
// validate its input, at which point these tests threw before asserting
// anything -- and because no CI runs on this branch, they simply stayed
// broken. Anything crossing the API boundary in a test has to satisfy the
// same contract the product does.
const requestId = "req_44444444-4444-4444-8444-444444444444";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const callerUserId = "44444444-4444-4444-8444-444444444444";

function membership(
  organizationId: string,
  role: Membership["role"],
  userId: string = callerUserId
): Membership {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    membershipId: "33333333-3333-4333-8333-333333333333",
    organizationId,
    userId,
    role,
    createdAt: "2026-08-21T12:00:00.000Z"
  };
}

test("a recruiter membership in the requested org authorizes a recruiter capability", () => {
  const result = authorizeResourceAccess(
    [membership(orgA, "recruiter")],
    orgA,
    "review_candidates",
    callerUserId
  );
  assert.deepEqual(result, { outcome: "authorized", role: "recruiter" });
});

test("a client-supplied organizationId the caller has no membership in is never trusted", () => {
  // The caller only has a membership in orgA; orgB is not theirs, whether or not orgB even exists.
  const result = authorizeResourceAccess(
    [membership(orgA, "owner")],
    orgB,
    "review_candidates",
    callerUserId
  );
  assert.deepEqual(result, { outcome: "no_membership" });
});

test("having no memberships at all yields no_membership, not a crash", () => {
  const result = authorizeResourceAccess([], orgA, "review_candidates", callerUserId);
  assert.deepEqual(result, { outcome: "no_membership" });
});

test("a real membership without the capability is insufficient_capability, not no_membership", () => {
  const result = authorizeResourceAccess(
    [membership(orgA, "auditor")],
    orgA,
    "review_candidates",
    callerUserId
  );
  assert.deepEqual(result, { outcome: "insufficient_capability", role: "auditor" });
});

test("a membership row for a different user is ignored even if it is in the array", () => {
  const otherUser = "55555555-5555-4555-8555-555555555555";
  const result = authorizeResourceAccess(
    [membership(orgA, "owner", otherUser)],
    orgA,
    "review_candidates",
    callerUserId
  );
  assert.deepEqual(result, { outcome: "no_membership" });
});

test("UUID letter-case is not treated as a different organization or user", () => {
  const result = authorizeResourceAccess(
    [membership(orgA.toUpperCase(), "recruiter", callerUserId.toUpperCase())],
    orgA,
    "review_candidates",
    callerUserId
  );
  assert.deepEqual(result, { outcome: "authorized", role: "recruiter" });
});

test("no_membership maps to not_found so an org's existence is never confirmed to an outsider", () => {
  const response = resourceAuthorizationErrorResponse({ outcome: "no_membership" }, requestId);
  assert.equal(response?.status, 404);
  assert.equal(response?.body.error.code, "not_found");
  // Status mapping alone is not enough: without this, a body that violates
  // apiErrorBodySchema passes as long as the code and status line up.
  assert.equal(apiErrorBodySchema.safeParse(response?.body).success, true);
});

test("insufficient_capability maps to forbidden, and names the actual role", () => {
  const response = resourceAuthorizationErrorResponse(
    { outcome: "insufficient_capability", role: "auditor" },
    requestId
  );
  assert.equal(response?.status, 403);
  assert.equal(response?.body.error.code, "forbidden");
  assert.match(response?.body.error.message ?? "", /auditor/);
  assert.equal(apiErrorBodySchema.safeParse(response?.body).success, true);
});

test("authorized yields no error response", () => {
  const response = resourceAuthorizationErrorResponse({ outcome: "authorized", role: "owner" }, requestId);
  assert.equal(response, undefined);
});

test("a malformed request id is refused rather than emitted in a response body", () => {
  // The other half of why the fixture above had to change. Asserting the
  // corrected fixture passes shows the suite is green again; asserting
  // that `req_x` still throws is what stops the next person hitting a
  // failure here from "fixing" it by loosening AF-13's validation
  // instead of the fixture. An error body carrying a request id nothing
  // can be correlated with is not much of an error report.
  assert.throws(
    () => resourceAuthorizationErrorResponse({ outcome: "no_membership" }, "req_x"),
    /RequestId/
  );
});

test("the request id reaches the error body verbatim, which is why it has to be well-formed", () => {
  const response = resourceAuthorizationErrorResponse({ outcome: "no_membership" }, requestId);
  assert.equal(response?.body.requestId, requestId);
});
