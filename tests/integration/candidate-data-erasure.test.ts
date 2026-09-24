import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCandidateDataErasure,
  assertCandidateDataErasureGuards
} from "../../packages/db/src/index.ts";

// AF-62. Every claim the erasure makes is a claim made to a candidate, so
// none of it is asserted by reading the SQL. One probe builds the whole
// scenario against real migrations; the tests below read its observations.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

function requireDatabase(): string {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the constraints and append-only triggers for real. See README.md."
    );
  }
  return DATABASE_URL;
}

async function observe(): Promise<Awaited<ReturnType<typeof assertCandidateDataErasure>>> {
  return assertCandidateDataErasure(requireDatabase());
}

test("erasing one candidate does not erase the CSV they shared with another", async () => {
  // The case a naive implementation gets wrong without anyone noticing:
  // applications.intake_id is not unique, so one CSV yields many
  // candidates, and erasing the shared document on the first request
  // destroys data belonging to people who never asked for anything.
  const observed = await observe();
  assert.equal(observed.firstErasureIntakeErased, false);
  assert.equal(observed.firstErasureDeferredCount, 1);
  assert.match(observed.textAfterFirstErasure, /Jane Doe, Python engineer/);
  assert.equal(observed.otherCandidateNameAfterFirstErasure, "Sam Roe");
  // Snapshotted at that moment, not read afterwards: by the time the probe
  // returns, the second erasure has legitimately deleted the object.
  assert.equal(observed.deletedObjectCountAfterFirstErasure, 0);
});

test("a deferred erasure receipt does not claim the shared document was erased", async () => {
  // REV-005. intakeDeferred and the candidate-facing statement must agree.
  const observed = await observe();
  assert.equal(observed.firstErasureIntakeErased, false);
  assert.doesNotMatch(
    observed.firstResidueStatement,
    /Original documents, canonical text and candidate identity were erased/
  );
  assert.match(observed.firstResidueStatement, /retained until the 1 other candidate/);
});

test("erasing the last candidate on the intake erases the document and its text", async () => {
  const observed = await observe();
  assert.equal(observed.lastErasureIntakeErased, true);
  assert.doesNotMatch(observed.textAfterLastErasure, /Jane Doe/);
  assert.equal(observed.textAfterLastErasure, "[]");
  assert.equal(observed.filenameAfterLastErasure, "[erased]");
  assert.equal(observed.erasedNameAfterLastErasure, "[erased]");
  assert.equal(observed.externalReferenceAfterLastErasure, null);
});

test("the stored object is deleted, and by the key it actually had", async () => {
  const observed = await observe();
  assert.equal(observed.deletedObjectKeys.length, 1);
  // Deleted while the real key was still readable. If the redaction ran
  // first this would be the placeholder, and the real object would be
  // orphaned in the bucket forever.
  assert.match(observed.deletedObjectKeys[0] ?? "", /Jane_Doe_CV\.pdf$/);
});

test("storage_key no longer carries the candidate's name", async () => {
  // Redacting declared_filename alone would leave the name in the key.
  const observed = await observe();
  assert.doesNotMatch(observed.storageKeyAfterLastErasure, /Jane_Doe/);
  assert.match(observed.storageKeyAfterLastErasure, /^erased:/);
});

test("a failed import row keeps its CHECK invariant instead of violating it", async () => {
  // import_rows carries CHECK ((outcome = 'failed') = (failure_reason IS
  // NOT NULL)). Nulling the column would make every failed row illegal, so
  // the erasure has to place a placeholder there and leave the processed
  // row's NULL alone.
  const observed = await observe();
  assert.equal(observed.failedRowReasonAfterErasure, "[erased]");
  assert.doesNotMatch(observed.failedRowReasonAfterErasure, /Jane Doe/);
  assert.equal(observed.processedRowReasonAfterErasure, null);
});

test("the residue is real: the quote and the rationale both survive", async () => {
  // This is the ticket's unfinished half, asserted rather than described
  // so it cannot quietly stop being true in either direction. If AF-91
  // lands and these become erasable, this test fails and the receipt's
  // wording has to be revisited.
  const observed = await observe();
  assert.equal(observed.evidenceQuoteAfterErasure, "Jane Doe, Python engineer");
  assert.equal(observed.decisionRationaleAfterErasure, "Jane Doe interviews well");
});

test("re-running an erasure does not append a second receipt", async () => {
  // A retention job that crashes halfway gets re-run. Two receipts for one
  // erasure would misstate what happened.
  const observed = await observe();
  assert.equal(observed.secondRunAlreadyErased, true);
  assert.equal(observed.receiptCount, 2, "one receipt per application, not per attempt");
});

test("the receipt cannot be edited afterwards", async () => {
  // The party with a motive to rewrite a receipt that admits residue is
  // the party the receipt holds accountable.
  const observed = await observe();
  assert.match(observed.ledgerUpdateRejection, /append-only: UPDATE is not allowed/);
});

test("one organization cannot erase another's application", async () => {
  const observed = await observe();
  assert.match(observed.crossTenantRejection, /no application .* in organization/);
});

test("skip_for_test leaves storage_key intact and records object storage as residue", async () => {
  // REV-003. Overwriting the key without deleting the object is the orphan
  // trap. The explicit test opt-out must not take that path.
  const observed = await assertCandidateDataErasureGuards(requireDatabase());
  assert.equal(observed.skipErasedIntake, true);
  assert.equal(observed.storageKeyAfterSkip, observed.originalStorageKey);
  assert.match(observed.skipResidueStatement, /stored object was not deleted/);
});

// ---- REV-006: skip mode must not tell any reader the intake is finished ----

test("skip mode leaves the intake unfinished, so reconciliation still counts it as residue", async () => {
  // file_intakes.redacted_at means "this row holds no candidate data" to
  // every reader. After skip mode storage_key still embeds the filename and
  // the object is still stored, so the row must not carry that marker.
  const observed = await assertCandidateDataErasureGuards(requireDatabase());
  assert.equal(observed.redactedAtAfterSkip, null, "redacted_at must stay NULL while the object is still stored");
  assert.equal(observed.declaredFilenameAfterSkip, "[erased]", "what can be redacted in place still is");
  assert.ok(observed.reconciliationCountsSkippedIntake >= 1, "observeRetentionResidue must count the unfinished intake");
  assert.ok(observed.skipResidueSurfaces.includes("file_intakes"), "the receipt must list file_intakes as residue");
  assert.ok(observed.skipResidueSurfaces.includes("object_storage_documents"));
});

test("a later erasure with a real deleter finishes what skip mode left", async () => {
  // Before REV-006 this was unrecoverable: redacted_at was set, so the
  // repair branch never ran and the object and key stayed forever.
  const observed = await assertCandidateDataErasureGuards(requireDatabase());
  assert.deepEqual(observed.keysDeletedByLaterRealErasure, [observed.originalStorageKey]);
  assert.match(observed.storageKeyAfterRealErasure, /^erased:/);
  assert.ok(observed.redactedAtAfterRealErasure !== null, "the real erasure sets redacted_at");
  assert.equal(observed.reconciliationAfterRealErasure, 0, "and reconciliation now reads it as clean");
});

test("repeating skip mode writes no receipt for a repair that did nothing", async () => {
  const observed = await assertCandidateDataErasureGuards(requireDatabase());
  assert.equal(observed.receiptsAddedBySecondSkip, 0);
});

test("an erased application refuses an evidence correction too, the third append-only writer", async () => {
  // REV-004 guarded recordEvidenceOutcome and recordCandidateDecision and
  // missed this one. It is not a race: after the erasure, a correction
  // superseding the surviving head used to insert a new row carrying a new
  // quote and a free-text correction_reason, residue grown after the receipt.
  const observed = await assertCandidateDataErasureGuards(requireDatabase());
  assert.match(observed.correctionRejection, /is erased or missing/);
  assert.equal(observed.evidenceRowsAfterCorrection, 1, "only the evidence from before the erasure may remain");
});

test("erased applications refuse new evidence and decisions and leave the review queue", async () => {
  // REV-004. Append-only writers must not grow residue after the receipt.
  const observed = await assertCandidateDataErasureGuards(requireDatabase());
  assert.match(observed.evidenceRejection, /is erased or missing/);
  assert.match(observed.decisionRejection, /is erased or missing/);
  assert.equal(observed.listedAfterErasure, 0);
  assert.equal(observed.getAfterErasure, false);
});
