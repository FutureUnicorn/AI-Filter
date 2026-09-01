import assert from "node:assert/strict";
import test from "node:test";

import { assertCandidateDataErasure } from "../../packages/db/src/index.ts";

// AF-62. Every claim the erasure makes is a claim made to a candidate, so
// none of it is asserted by reading the SQL. One probe builds the whole
// scenario against real migrations; the tests below read its observations.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

async function observe(): Promise<Awaited<ReturnType<typeof assertCandidateDataErasure>>> {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the constraints and append-only triggers for real. See README.md."
    );
  }
  return assertCandidateDataErasure(DATABASE_URL);
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
