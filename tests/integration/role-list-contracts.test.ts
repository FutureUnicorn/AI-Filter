import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import {
  listRolesQuerySchema,
  roleListItemSchema,
  roleListResponseSchema,
  sessionContextSchema
} from "../../packages/contracts/src/index.ts";

const roleId = "11111111-4111-4111-8111-111111111111";
const organizationId = "22222222-4222-4222-8222-222222222222";
const createdByUserId = "33333333-4333-4333-8333-333333333333";
const createdAt = "2026-08-22T12:00:00.000Z";
const userId = "44444444-4444-4444-8444-444444444444";
const membershipId = "55555555-4555-4555-8555-555555555555";

const role = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  roleId,
  organizationId,
  title: "Backend Engineer",
  status: "draft" as const,
  createdByUserId,
  createdAt
};

test("listRolesQuerySchema requires a uuid organizationId", () => {
  assert.equal(listRolesQuerySchema.safeParse({ organizationId }).success, true);
  assert.equal(listRolesQuerySchema.safeParse({}).success, false);
  assert.equal(listRolesQuerySchema.safeParse({ organizationId: "not-a-uuid" }).success, false);
});

test("a current (no-rubric, empty-counts) list item parses", () => {
  const result = roleListItemSchema.safeParse({
    role,
    counts: { applications: 0, processed: 0, waiting: 0, failed: 0 },
    rubricApprovalState: "none",
    importReadiness: { outcome: "blocked", reason: "no_approved_rubric" }
  });
  assert.equal(result.success, true);
});

test("roleListItemSchema rejects a ready item that still carries a blocked reason", () => {
  assert.equal(
    roleListItemSchema.safeParse({
      role,
      counts: { applications: 0, processed: 0, waiting: 0, failed: 0 },
      rubricApprovalState: "approved",
      importReadiness: { outcome: "ready", reason: "no_approved_rubric" }
    }).success,
    false
  );
});

test("roleListResponseSchema accepts an empty list and rejects an unrecognized property", () => {
  assert.equal(roleListResponseSchema.safeParse({ roles: [] }).success, true);
  assert.equal(roleListResponseSchema.safeParse({ roles: [], extra: true }).success, false);
});

test("sessionContextSchema accepts memberships plus the organizations they name", () => {
  const result = sessionContextSchema.safeParse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    userId,
    memberships: [
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        membershipId,
        organizationId,
        userId,
        role: "recruiter",
        createdAt
      }
    ],
    organizations: [
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        organizationId,
        name: "Acme",
        createdAt
      }
    ]
  });
  assert.equal(result.success, true);
});
