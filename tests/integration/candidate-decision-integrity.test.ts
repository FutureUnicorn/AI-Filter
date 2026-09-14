import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCandidateDecisionIntegrity,
  assertConcurrentFirstDecisionHasOneRoot
} from "../../packages/db/src/index.ts";

// AF-51. The pure derivation is covered in tests/unit; this is the half
// only a real database can answer -- that applications holds no
// competing status column, that no decision can be recorded without a
// named member and a rationale, and that two reviewers deciding at once
// cannot fork the chain.

test("candidate decisions are the only status, always named, and never forked", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises candidate decisions against real Postgres"
    );
  }
  await assertCandidateDecisionIntegrity(databaseUrl);
});

// ---- PR #83 review, P1: concurrent first decisions ----
//
// recordCandidateDecision serialized by taking FOR UPDATE on the current
// head. A candidate with no decisions has no head row, and FOR UPDATE cannot
// lock a row that does not exist, so two first-time transactions both read no
// head and both inserted a NULL predecessor. 0020's partial unique index
// excludes NULLs by its own predicate, so both committed: two roots, two
// current states, one of them silently unchained.
//
// The existing integrity probe begins after a first decision exists, so it
// exercises only the head lock and could never reach this case.
test("two concurrent first decisions leave exactly one root and one head", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises the concurrent-first-decision race against real Postgres"
    );
  }
  const observed = await assertConcurrentFirstDecisionHasOneRoot(databaseUrl);

  // The invariant Sai asked for, stated directly.
  assert.equal(observed.rootCount, 1, `exactly one root decision must exist, found ${observed.rootCount}`);
  assert.equal(observed.headCount, 1, `exactly one current decision must exist, found ${observed.headCount}`);

  // Both writes are still accounted for: the race is resolved by one
  // superseding the other, not by dropping a decision on the floor. A fix
  // that serialized by discarding the loser would pass the two assertions
  // above while losing a human's recorded decision, so this is checked too.
  assert.equal(observed.totalDecisions, 2, "both decisions must be recorded, with one superseding the other");
  assert.equal(observed.recorded, 2, "each caller must be told its decision was recorded");
  assert.equal(observed.superseded, 0);
});
