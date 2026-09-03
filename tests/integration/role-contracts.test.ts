import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import { createRoleInputSchema, roleSchema } from "../../packages/contracts/src/index.ts";

const roleId = "11111111-4111-4111-8111-111111111111";
const organizationId = "22222222-4222-4222-8222-222222222222";
const createdByUserId = "33333333-4333-4333-8333-333333333333";
const createdAt = "2026-08-22T12:00:00.000Z";

test("a well-formed draft role parses successfully", () => {
  const result = roleSchema.safeParse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    roleId,
    organizationId,
    title: "Backend Engineer",
    status: "draft",
    createdByUserId,
    createdAt
  });
  assert.equal(result.success, true);
});

test("roleSchema rejects an unknown status and an unrecognized property", () => {
  assert.equal(
    roleSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      roleId,
      organizationId,
      title: "Backend Engineer",
      status: "archived",
      createdByUserId,
      createdAt
    }).success,
    false
  );
  assert.equal(
    roleSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      roleId,
      organizationId,
      title: "Backend Engineer",
      status: "draft",
      createdByUserId,
      createdAt,
      department: "Engineering"
    }).success,
    false
  );
});

test("createRoleInputSchema accepts an organizationId and a non-empty title", () => {
  const result = createRoleInputSchema.safeParse({ organizationId, title: "Backend Engineer" });
  assert.equal(result.success, true);
});

test("createRoleInputSchema trims but does not accept a blank or oversized title", () => {
  assert.equal(createRoleInputSchema.safeParse({ organizationId, title: "   " }).success, false);
  assert.equal(
    createRoleInputSchema.safeParse({ organizationId, title: "x".repeat(201) }).success,
    false
  );
  const trimmed = createRoleInputSchema.safeParse({ organizationId, title: "  Backend Engineer  " });
  assert.equal(trimmed.success, true);
  assert.equal(trimmed.success && trimmed.data.title, "Backend Engineer");
});

test("createRoleInputSchema rejects a non-uuid organizationId and a missing title", () => {
  assert.equal(
    createRoleInputSchema.safeParse({ organizationId: "not-a-uuid", title: "Backend Engineer" }).success,
    false
  );
  assert.equal(createRoleInputSchema.safeParse({ organizationId }).success, false);
});
