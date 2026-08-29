import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

// ---- AF-15 review: the database and the contract must agree on email ----
//
// The PR claimed these two layers mirror one another. They did not: the
// migration's CHECK was `position('@' in email) > 1`, which only asserts
// that an '@' appears after the first character, so 'a@', 'a@@b' and
// 'a@ b' were all accepted by Postgres while userSchema rejected them.
// Verified as accepted on Postgres 17 before the fix, and rejected after.
//
// This branch's CI has no Postgres service, so the SQL side cannot be
// exercised here. What this does instead is keep the claim honest in the
// two ways that are checkable without a database: the contract layer
// really does reject the whole corpus, and the migration really does
// carry the pattern that was verified against that same corpus. Weaken
// either side and one of these fails.

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/db/migrations/0002_organizations_users_memberships.sql"
);

/** The exact pattern verified against Postgres 17 for this corpus. */
const VERIFIED_SQL_EMAIL_PATTERN = "'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'";

const MALFORMED_EMAILS = [
  "a@", // no domain at all -- accepted by the old CHECK
  "a@@b", // two '@' -- accepted by the old CHECK
  "a@ b", // whitespace inside -- accepted by the old CHECK
  "@example.com", // empty local part
  "a@b" // undotted domain
];

// Case is the one place the two layers deliberately do NOT mirror, and
// leaving it out of the corpus above is the point rather than an
// oversight: storedEmailSchema accepts 'Ok@Example.com' and normalises
// it to lowercase, and the database CHECK requires `email = lower(email)`
// because normalisation has already happened by the time a row is
// written. Both are right; they are enforcing the same invariant at
// different ends of the same pipe.

const WELL_FORMED_EMAILS = ["ok@example.com", "first.last@sub.example.co.uk", "a_b-c@example.org"];

test("the contract layer rejects every malformed address the database now rejects", () => {
  for (const email of MALFORMED_EMAILS) {
    assert.equal(
      userSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        userId,
        email,
        displayName: "Casey Rivera",
        createdAt
      }).success,
      false,
      `expected userSchema to reject ${JSON.stringify(email)}`
    );
  }
});

test("neither layer rejects an address that is simply valid", () => {
  for (const email of WELL_FORMED_EMAILS) {
    assert.equal(
      userSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        userId,
        email,
        displayName: "Casey Rivera",
        createdAt
      }).success,
      true,
      `expected userSchema to accept ${JSON.stringify(email)}`
    );
  }
});

test("the migration still carries the email pattern that was verified against Postgres", () => {
  // Not a substitute for running the SQL -- it is a tripwire. Someone
  // relaxing the CHECK back toward `position('@' in email)` would restore
  // the exact mismatch this review found, and no other test on this
  // branch would notice.
  const migration = readFileSync(MIGRATION_PATH, "utf8");
  assert.ok(
    migration.includes(VERIFIED_SQL_EMAIL_PATTERN),
    "0002's users email CHECK no longer uses the verified pattern"
  );
  // Comment lines are stripped first: the migration deliberately quotes
  // the old `position('@' in email)` check in prose to explain what was
  // wrong with it, and a naive substring search would trip on its own
  // documentation.
  const executable = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.ok(
    !executable.includes("position('@' in email)"),
    "0002 reintroduced the position('@' in email) check, which accepts 'a@', 'a@@b' and 'a@ b'"
  );
});

test("memberships keeps exactly one index per distinct access path", () => {
  // UNIQUE (organization_id, user_id) already indexes organization_id as
  // its leftmost column. Confirmed on Postgres 17 with 40,000 rows: with
  // memberships_organization_id_idx dropped, the planner uses
  // memberships_organization_id_user_id_key for the identical query and
  // the same plan shape, never a sequential scan. user_id is not a
  // leftmost prefix of anything, so its own index stays.
  const migration = readFileSync(MIGRATION_PATH, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.ok(
    migration.includes("CREATE INDEX IF NOT EXISTS memberships_user_id_idx"),
    "memberships still needs its user_id index; that access path has no other cover"
  );
  assert.ok(
    !migration.includes("CREATE INDEX IF NOT EXISTS memberships_organization_id_idx"),
    "memberships_organization_id_idx duplicates the UNIQUE (organization_id, user_id) access path"
  );
});
