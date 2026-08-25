import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION, MEMBERSHIP_ROLES } from "../../packages/domain/src/index.ts";
import {
  membershipSchema,
  organizationSchema,
  userSchema
} from "../../packages/contracts/src/index.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const membershipId = "33333333-3333-4333-8333-333333333333";
const createdAt = "2026-08-21T12:00:00.000Z";

test("a well-formed organization parses successfully", () => {
  const result = organizationSchema.safeParse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId,
    name: "Acme Hiring",
    createdAt
  });
  assert.equal(result.success, true);
});

test("organizationSchema rejects an unrecognized property and an empty name", () => {
  assert.equal(
    organizationSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId,
      name: "Acme Hiring",
      createdAt,
      billingPlan: "enterprise"
    }).success,
    false
  );
  assert.equal(
    organizationSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      organizationId,
      name: "",
      createdAt
    }).success,
    false
  );
});

test("a well-formed user parses successfully", () => {
  const result = userSchema.safeParse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    userId,
    email: "recruiter@acme.test",
    displayName: "Ada Recruiter",
    createdAt
  });
  assert.equal(result.success, true);
});

test("userSchema lowercases mixed-case emails to match the stored-email CHECK", () => {
  const result = userSchema.safeParse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    userId,
    email: "Recruiter@Acme.test",
    displayName: "Ada Recruiter",
    createdAt
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.email, "recruiter@acme.test");
  }
});

test("userSchema rejects a malformed email and a malformed uuid", () => {
  assert.equal(
    userSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      userId,
      email: "not-an-email",
      displayName: "Ada Recruiter",
      createdAt
    }).success,
    false
  );
  assert.equal(
    userSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      userId: "not-a-uuid",
      email: "recruiter@acme.test",
      displayName: "Ada Recruiter",
      createdAt
    }).success,
    false
  );
});

test("membershipSchema accepts every role named in MEMBERSHIP_ROLES", () => {
  for (const role of MEMBERSHIP_ROLES) {
    const result = membershipSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      membershipId,
      organizationId,
      userId,
      role,
      createdAt
    });
    assert.equal(result.success, true, `role ${role} should be accepted`);
  }
});

test("membershipSchema rejects a role outside the closed set", () => {
  const result = membershipSchema.safeParse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    membershipId,
    organizationId,
    userId,
    role: "superadmin",
    createdAt
  });
  assert.equal(result.success, false);
});

test("every schema is pinned to CONTRACT_SCHEMA_VERSION; a stale version is rejected", () => {
  assert.equal(
    organizationSchema.safeParse({
      schemaVersion: "0.9.0",
      organizationId,
      name: "Acme Hiring",
      createdAt
    }).success,
    false
  );
});
