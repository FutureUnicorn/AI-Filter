import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  EMPTY_ROLE_PIPELINE_COUNTS,
  deriveImportReadiness,
  toRoleListItem
} from "../../packages/domain/src/index.ts";
import type { Role } from "../../packages/domain/src/index.ts";

const role: Role = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  roleId: "11111111-4111-4111-8111-111111111111",
  organizationId: "22222222-4222-4222-8222-222222222222",
  title: "Backend Engineer",
  status: "draft",
  createdByUserId: "33333333-4333-4333-8333-333333333333",
  createdAt: "2026-08-22T12:00:00.000Z"
};

test("a draft role with no rubric is blocked on the missing rubric, not on draft status", () => {
  assert.deepEqual(deriveImportReadiness("draft", "none"), {
    outcome: "blocked",
    reason: "no_approved_rubric"
  });
});

test("an approved rubric on a still-draft role is blocked as not yet active", () => {
  assert.deepEqual(deriveImportReadiness("draft", "approved"), {
    outcome: "blocked",
    reason: "role_not_active"
  });
});

test("an active role with an approved rubric is import-ready", () => {
  assert.deepEqual(deriveImportReadiness("active", "approved"), { outcome: "ready" });
});

test("closed is terminal even if a rubric was approved", () => {
  assert.deepEqual(deriveImportReadiness("closed", "approved"), {
    outcome: "blocked",
    reason: "role_closed"
  });
});

test("toRoleListItem attaches derived import readiness without inventing counts", () => {
  const item = toRoleListItem(role, EMPTY_ROLE_PIPELINE_COUNTS, "none");
  assert.equal(item.role.title, "Backend Engineer");
  assert.deepEqual(item.counts, EMPTY_ROLE_PIPELINE_COUNTS);
  assert.equal(item.rubricApprovalState, "none");
  assert.deepEqual(item.importReadiness, { outcome: "blocked", reason: "no_approved_rubric" });
});
