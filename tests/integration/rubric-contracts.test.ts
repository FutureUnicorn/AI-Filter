import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  MAX_RUBRIC_CRITERIA,
  MIN_RUBRIC_CRITERIA
} from "../../packages/domain/src/index.ts";
import type { RubricCriterion } from "../../packages/domain/src/index.ts";
import { rubricSchema, upsertRubricDraftInputSchema } from "../../packages/contracts/src/index.ts";
import { assertRubricDraftPersistence } from "../../packages/db/src/index.ts";
import { mapRubricToEvidence } from "../../packages/ai/src/index.ts";

// AF-25's own suite. The PR described a test plan that was never
// committed, so before this file nothing covered the rubric API, its
// persistence, its versioning, or its 5-10 / criterion-ID boundaries --
// which is how the duplicate-criterionId defect below survived review.

const rubricId = "11111111-4111-4111-8111-111111111111";
const roleId = "22222222-4222-4222-8222-222222222222";
const timestamp = "2026-08-22T12:00:00.000Z";

function criterion(criterionId: string): RubricCriterion {
  return {
    criterionId,
    description: `description for ${criterionId}`,
    evidenceGuidance: `guidance for ${criterionId}`
  };
}

/** `count` criteria with distinct IDs, so only the property under test varies. */
function distinctCriteria(count: number): RubricCriterion[] {
  return Array.from({ length: count }, (_, index) => criterion(`criterion_${index}`));
}

function storedRubric(criteria: readonly RubricCriterion[]): Record<string, unknown> {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    rubricId,
    roleId,
    version: 1,
    status: "draft",
    criteria,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

// ---- the P1: the API accepted rubrics the mapper rejects ----

test("a duplicate criterionId is rejected instead of being persisted", () => {
  // The reviewer's exact scenario: five criteria, all the same ID.
  const result = upsertRubricDraftInputSchema.safeParse({
    criteria: Array.from({ length: MIN_RUBRIC_CRITERIA }, () => criterion("python_production"))
  });
  assert.equal(result.success, false, "five criteria sharing one ID must not be accepted");
});

test("the duplicate is reported against its own row, naming the criterion it collides with", () => {
  // A whole-array error would make an editor highlight all ten rows. The
  // path points at the offending element so the UI can point at it, and
  // the message names the earlier position so the author can see the pair.
  const criteria = [criterion("a"), criterion("b"), criterion("a"), ...distinctCriteria(2)];
  const result = upsertRubricDraftInputSchema.safeParse({ criteria });
  assert.equal(result.success, false);
  if (result.success) {
    return;
  }
  const issue = result.error.issues.find((entry) => entry.message.includes("already used by criterion"));
  assert.ok(issue, `expected a duplicate-criterionId issue, got: ${JSON.stringify(result.error.issues)}`);
  assert.deepEqual(issue.path, ["criteria", 2, "criterionId"], "the third row is the duplicate");
  assert.match(issue.message, /criterionId "a" is already used by criterion 1/u);
});

test("a rubric the contract accepts is one the mapper will run", () => {
  // The defect this suite exists for. The API and mapRubricToEvidence
  // disagreed about what a valid rubric is, and the API was the more
  // permissive one -- so a save returned 200 and the first extraction run
  // against that role threw. Anything accepted here must survive the
  // mapper, or a rubric can be saved and then never used.
  const accepted = upsertRubricDraftInputSchema.parse({ criteria: distinctCriteria(MAX_RUBRIC_CRITERIA) });
  const subject = {
    organizationId: "33333333-3333-4333-8333-333333333333",
    candidateId: "44444444-4444-4444-8444-444444444444"
  };
  assert.doesNotThrow(() =>
    mapRubricToEvidence(
      subject,
      accepted.criteria.map((entry) => entry.criterionId),
      []
    )
  );
});

test("the mapper still rejects duplicates, so the contract is the layer that has to stop them", () => {
  // Pins the other half of the agreement: this is the throw the contract
  // now prevents a caller from ever reaching. If the mapper ever stopped
  // rejecting duplicates, the test above would keep passing for the wrong
  // reason, and this one would fail and say so.
  const subject = {
    organizationId: "33333333-3333-4333-8333-333333333333",
    candidateId: "44444444-4444-4444-8444-444444444444"
  };
  assert.throws(
    () => mapRubricToEvidence(subject, ["python_production", "python_production"], []),
    /requires unique rubric criterion IDs; "python_production" appears more than once/u
  );
});

test("the stored rubric carries the same uniqueness rule as the input", () => {
  assert.equal(rubricSchema.safeParse(storedRubric([criterion("a"), criterion("a")])).success, false);
  assert.equal(rubricSchema.safeParse(storedRubric(distinctCriteria(MIN_RUBRIC_CRITERIA))).success, true);
});

// ---- the 5-10 boundary ----

test("the 5-10 criterion bound holds in all four directions", () => {
  // Driven off the constants rather than literals: if the product bound
  // changes, this follows it instead of silently pinning 5 and 10.
  const cases: readonly { readonly count: number; readonly accepted: boolean }[] = [
    { count: MIN_RUBRIC_CRITERIA - 1, accepted: false },
    { count: MIN_RUBRIC_CRITERIA, accepted: true },
    { count: MAX_RUBRIC_CRITERIA, accepted: true },
    { count: MAX_RUBRIC_CRITERIA + 1, accepted: false }
  ];
  for (const { count, accepted } of cases) {
    assert.equal(
      upsertRubricDraftInputSchema.safeParse({ criteria: distinctCriteria(count) }).success,
      accepted,
      `${count} criteria should ${accepted ? "be accepted" : "be rejected"}`
    );
  }
});

// ---- criterion-ID validation ----

test("an empty or whitespace-only criterionId is rejected", () => {
  // criterionId is the key an extracted item is matched against, so a
  // blank one names a criterion nothing can ever cite. Whitespace-only
  // used to pass: the field had a bare min(1) while its two siblings were
  // already trimmed.
  for (const blank of ["", " ", "   ", "\t", "\n"]) {
    assert.equal(
      upsertRubricDraftInputSchema.safeParse({
        criteria: [criterion(blank), ...distinctCriteria(MIN_RUBRIC_CRITERIA - 1)]
      }).success,
      false,
      `criterionId ${JSON.stringify(blank)} must be rejected`
    );
  }
});

test("criterionId is trimmed, so surrounding whitespace cannot smuggle a duplicate past the check", () => {
  // Without trimming, "a" and "a " are distinct strings and both would be
  // accepted, then collide as one key downstream -- the uniqueness rule
  // would read as enforced while not being.
  const result = upsertRubricDraftInputSchema.safeParse({
    criteria: [criterion("a"), criterion(" a "), ...distinctCriteria(MIN_RUBRIC_CRITERIA - 2)]
  });
  assert.equal(result.success, false, "' a ' collides with 'a' once trimmed");

  const trimmed = upsertRubricDraftInputSchema.parse({
    criteria: [criterion("  spaced  "), ...distinctCriteria(MIN_RUBRIC_CRITERIA - 1)]
  });
  assert.equal(trimmed.criteria[0]?.criterionId, "spaced", "the stored id is the trimmed one");
});

test("an unrecognized property on a criterion is rejected", () => {
  // rubricCriterionSchema is a strictObject; this pins that a client
  // cannot park extra state on a criterion and have it persisted.
  const [first, ...rest] = distinctCriteria(MIN_RUBRIC_CRITERIA);
  assert.equal(
    upsertRubricDraftInputSchema.safeParse({
      criteria: [{ ...first, weight: 3 }, ...rest]
    }).success,
    false
  );
});

// ---- persistence and versioning, against real Postgres ----

test("a draft round-trips, edits in place, and only allocates a new version when inserting", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test exercises " +
        "packages/db/migrations/0010_rubrics.sql for real, including the one-draft-per-role unique index. " +
        "Locally: run `pnpm dev:infra`, then set it to " +
        "postgresql://signal_audit_local:local-only-password@localhost:5432/signal_audit_local (see README.md)."
    );
  }

  const observed = await assertRubricDraftPersistence(databaseUrl);

  // The documented rule from upsertDraftRubric: overwrite the draft in
  // place, keeping its version; allocate MAX(version) + 1 only on insert.
  assert.equal(observed.firstSaveVersion, 1, "the first draft is version 1");
  assert.equal(observed.editedSaveVersion, 1, "editing a draft must not allocate a new version");
  assert.deepEqual(observed.editedCriterionIds, ["a", "b", "c", "d", "z"], "PUT replaces the whole list");
  assert.equal(observed.draftRowsAfterEdit, 1, "editing must not leave a second draft behind");

  // Once the draft is published, the next save cannot touch it, so it
  // inserts a fresh draft above the highest existing version.
  assert.equal(observed.versionAfterPublished, 2, "a new draft above a published v1 is v2");
  assert.equal(observed.readBackIsDraft, true, "getRubricForRole prefers the draft over a published version");

  assert.equal(observed.unknownRoleOutcome, "no_such_role", "an unknown roleId is a typed outcome, not a crash");
});
