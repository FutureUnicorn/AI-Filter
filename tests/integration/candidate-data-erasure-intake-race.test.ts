import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCandidateDataErasureIntakeRace,
  assertCandidateDataErasureStrandedRepair
} from "../../packages/db/src/index.ts";

// REV-001 / AF-62. Two proofs, because the race and the repair are
// independent failure modes. The race test forces both erase transactions
// past their applications UPDATE together. The repair test seeds the
// stranded end-state directly, because a fixed race can no longer produce
// it, and an alreadyErased early return that skips the intake leaves that
// stranding silent and permanent.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

function requireDatabase(): string {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the race against live READ COMMITTED locking. See README.md."
    );
  }
  return DATABASE_URL;
}

test("concurrent erasures of siblings on one intake erase the shared document text", async () => {
  const observed = await assertCandidateDataErasureIntakeRace(requireDatabase());

  assert.equal(observed.firstAlreadyErased, false);
  assert.equal(observed.secondAlreadyErased, false);
  assert.equal(
    observed.firstIntakeErased || observed.secondIntakeErased,
    true,
    `at least one concurrent erase must take the intake-level path; got intakeErased=[${observed.firstIntakeErased}, ${observed.secondIntakeErased}] stillReferencing=[${observed.firstStillReferencing}, ${observed.secondStillReferencing}]`
  );
  assert.equal(
    observed.textAfterRace,
    "[]",
    `shared document text must be gone after both applications are erased; left ${observed.textAfterRace}`
  );
  assert.ok(observed.intakeRedactedAt !== null, "file_intakes.redacted_at must be set");
});

test("re-invoke after concurrent erase returns alreadyErased without leaving shared text", async () => {
  const observed = await assertCandidateDataErasureIntakeRace(requireDatabase());

  assert.equal(observed.recoveryAlreadyErased, true);
  assert.equal(
    observed.textAfterRecovery,
    "[]",
    `alreadyErased re-invoke must not leave shared text in place; left ${observed.textAfterRecovery}`
  );
});

test("alreadyErased re-invoke repairs a stranded intake and returns the original erasureId", async () => {
  const observed = await assertCandidateDataErasureStrandedRepair(requireDatabase());

  assert.equal(observed.repairAlreadyErased, true);
  assert.equal(observed.repairIntakeErased, true);
  assert.equal(
    observed.repairErasureId,
    observed.originalErasureId,
    "repair completes the original erasure event; it must return that erasureId, not a new one"
  );
  assert.equal(observed.textAfterRepair, "[]");
  assert.equal(observed.filenameAfterRepair, "[erased]");
  assert.ok(observed.intakeRedactedAfterRepair, "file_intakes.redacted_at must be set by the repair");
  assert.doesNotMatch(observed.storageKeyAfterRepair, /Jane_Doe/);
  assert.deepEqual(observed.deletedObjectKeys, [observed.originalStorageKey]);
  assert.equal(observed.receiptCountAfterRepair, 2, "repair appends one receipt describing the intake work");
  assert.ok(
    (observed.repairRowsBySurface["canonical_text_extractions"] ?? 0) >= 1,
    `rowsBySurface must describe the repair work; got ${JSON.stringify(observed.repairRowsBySurface)}`
  );
  assert.ok(
    (observed.repairRowsBySurface["file_intakes"] ?? 0) >= 1,
    `rowsBySurface must include file_intakes; got ${JSON.stringify(observed.repairRowsBySurface)}`
  );
  assert.equal(observed.repairRowsBySurface["object_storage_documents"], 1);
});

test("a second alreadyErased call after repair is idempotent", async () => {
  const observed = await assertCandidateDataErasureStrandedRepair(requireDatabase());

  assert.equal(observed.secondAlreadyErased, true);
  assert.equal(observed.secondIntakeErased, false);
  assert.equal(observed.receiptCountAfterSecond, 2, "idempotent re-invoke must not append another receipt");
  assert.equal(observed.secondDeletedObjectCount, 0, "idempotent re-invoke must not delete the object again");
});
