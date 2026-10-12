import assert from "node:assert/strict";
import test from "node:test";

import { assertEvidenceWriteRacingErasure } from "../../packages/db/src/index.ts";

// REV-007 / AF-62. An evidence writer racing an erasure that has written
// redacted_at but not committed. A snapshot check reads redacted_at as NULL
// and inserts; the foreign key then waits on the erasure's row lock and
// passes once it commits, because the key did not change. The result is a
// verbatim quote in an append-only table, written after the candidate's
// erasure, that can never be removed. The probe parks the erasure on a
// barrier so the interleaving is forced rather than hoped for.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

async function observe(): Promise<Awaited<ReturnType<typeof assertEvidenceWriteRacingErasure>>> {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the race against live READ COMMITTED locking. See README.md."
    );
  }
  return assertEvidenceWriteRacingErasure(DATABASE_URL);
}

test("the race was really exercised: all five writers were blocked on the erasure's lock", async () => {
  const observed = await observe();
  assert.ok(observed.writersBlockedBeforeRelease >= 5, `expected 5 blocked writers, saw ${observed.writersBlockedBeforeRelease}`);
});

test("the decision path, the control, refuses an application erased under it", async () => {
  // If this fails the harness is broken, not the fix: recordCandidateDecision
  // already locks FOR UPDATE ... AND redacted_at IS NULL.
  const observed = await observe();
  assert.match(observed.decisionError ?? "", /is erased or missing/);
  assert.equal(observed.decisionRowsAfterErasure, 0);
});

test("an evidence write racing an erasure is refused, and no quote lands after it", async () => {
  const observed = await observe();
  assert.match(
    observed.evidenceError ?? "",
    /is erased or missing/,
    `the evidence write must be refused; it inserted ${observed.evidenceRowsAfterErasure} row(s) instead`
  );
  assert.equal(observed.evidenceRowsAfterErasure, 0, "no evidence row may exist for the erased application");
  assert.equal(observed.evidenceRecordedDuringErasure, false);
});

test("an evidence correction racing an erasure is refused as well", async () => {
  // The correction supersedes a head from before the erasure, so its own
  // FOR UPDATE on that evidence row does not wait on the erasure; only a
  // lock on the application does.
  const observed = await observe();
  assert.match(observed.correctionError ?? "", /is erased or missing/, "the correction must be refused");
  assert.equal(observed.evidenceRowsAfterErasure, 0, "no evidence row may be added after the erasure");
});

// ---- REV-009 (Pradeep): the two writers the plan calls residue ----
//
// AF-62 now classifies audit_sample_members and review_timing_spans as
// candidate-identifying residue that erasure cannot remove. Residue that
// cannot be removed must not be able to GROW after the receipt is written,
// which is the same premise REV-004 closed for the evidence and decision
// writers -- and these two still inserted with no redacted_at check and no
// lock.
//
// The foreign key does not catch it. Erasure redacts the application in
// place rather than deleting it, so the key still resolves and the insert
// succeeds against an erased candidate.
//
// The timing route does call getApplicationById first, and that hides
// erased rows, which covers the ordinary case. It is a snapshot read on a
// different connection though, and this is the window it does not cover.

test("a review timing span racing an erasure is refused, and none lands after it", async () => {
  const observed = await observe();
  assert.match(
    observed.timingError ?? "",
    /is erased or missing/,
    `the timing write must be refused; it inserted ${observed.timingRowsAfterErasure} row(s) instead`
  );
  assert.equal(
    observed.timingRowsAfterErasure,
    0,
    "no span may tie an erased candidate's application_id to a named reviewer and a duration"
  );
});

test("an audit sample draw naming an erased candidate is refused", async () => {
  const observed = await observe();
  assert.match(
    observed.auditSampleError ?? "",
    /erased or missing/,
    `the draw must be refused; it inserted ${observed.auditSampleMemberRowsAfterErasure} member row(s) instead`
  );
  assert.equal(
    observed.auditSampleMemberRowsAfterErasure,
    0,
    "a draw must not record that an erased candidate was selected for audit"
  );
});
