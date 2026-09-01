import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_DATA_ERASURE_PLACEHOLDER,
  RETENTION_SURFACES,
  erasableSurfaces,
  erasedStorageKey,
  planCandidateDataErasure,
  summarizeCandidateDataErasureResidue,
  validateCandidateDataErasureRequest
} from "../../packages/domain/src/index.ts";

// AF-62. The plan is the part a reviewer reads and a receipt is written
// from, so the properties asserted here are the ones that would make the
// receipt a false statement if they broke.

test("a candidate request without a named requester is refused", () => {
  // The whole difference between the two triggers is attribution. A
  // request nobody is named on cannot be evidenced later, which defeats
  // the reason for recording it at all.
  assert.throws(
    () => planCandidateDataErasure("candidate_request"),
    /requires the user id of whoever requested it/
  );
  assert.throws(
    () => planCandidateDataErasure("candidate_request", "   "),
    /requires the user id of whoever requested it/
  );
});

test("a retention-expiry run refuses to name a requester", () => {
  // The inverse error, and the less obvious one: attaching a person to a
  // run the policy triggered puts their name against a decision they did
  // not make.
  assert.throws(
    () => planCandidateDataErasure("retention_expiry", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    /has no requester; it is the policy acting, not a person/
  );
  assert.doesNotThrow(() => validateCandidateDataErasureRequest("retention_expiry"));
});

test("the object is deleted before the row holding its key is redacted", () => {
  // This ordering is load-bearing and its failure mode is silent: redact
  // file_intakes first and storage_key -- the only handle to the object --
  // is gone, leaving bytes in the bucket that nothing can name, let alone
  // delete.
  const steps = erasableSurfaces(planCandidateDataErasure("retention_expiry"));
  const objectIndex = steps.findIndex((step) => step.surface === "object_storage_documents");
  const intakeIndex = steps.findIndex((step) => step.surface === "file_intakes");
  assert.notEqual(objectIndex, -1, "the stored object must be an erasure step");
  assert.notEqual(intakeIndex, -1, "file_intakes must be an erasure step");
  assert.ok(
    objectIndex < intakeIndex,
    "object storage must be erased before file_intakes, which holds the only key to it"
  );
});

test("storage_key is treated as candidate data, not just declared_filename", () => {
  // Easy to miss: the web layer builds the key as
  // `quarantine/{org}/{role}/pending/{uuid}-{declaredFilename}`, so it
  // carries the same name the filename column does.
  const intakeStep = planCandidateDataErasure("retention_expiry").steps.find(
    (step) => step.surface === "file_intakes"
  );
  assert.ok(intakeStep !== undefined);
  assert.ok(
    intakeStep.columns.includes("storage_key"),
    "redacting declared_filename while leaving storage_key would leave the candidate's name behind"
  );
  assert.ok(intakeStep.columns.includes("declared_filename"));
});

test("the storage-key replacement is unique per intake and carries nothing about the candidate", () => {
  // storage_key is NOT NULL UNIQUE, so a flat placeholder would collide on
  // the second erasure in any organization.
  const first = erasedStorageKey("55555555-5555-4555-8555-555555555555");
  const second = erasedStorageKey("99999999-9999-4999-8999-999999999999");
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /Jane|\.pdf|quarantine/);
  assert.throws(() => erasedStorageKey("  "), /non-empty intakeId/);
});

test("the placeholder survives the non-empty CHECK constraints it has to satisfy", () => {
  // applications.candidate_full_name, candidate_email and
  // file_intakes.declared_filename are all NOT NULL with a non-empty
  // CHECK. An erasure that wrote NULL or "" would be rejected outright.
  assert.ok(CANDIDATE_DATA_ERASURE_PLACEHOLDER.length > 0);
  assert.match(CANDIDATE_DATA_ERASURE_PLACEHOLDER, /[^[:space:]]/);
  assert.equal(CANDIDATE_DATA_ERASURE_PLACEHOLDER.trim(), CANDIDATE_DATA_ERASURE_PLACEHOLDER);
});

test("every retention surface is accounted for, so none is silently skipped", () => {
  // The same reasoning AF-61 applied to its own plan: a surface missing
  // from an erasure plan is not erased and nobody finds out.
  const planned = new Set(planCandidateDataErasure("retention_expiry").steps.map((s) => s.surface));
  for (const surface of RETENTION_SURFACES) {
    assert.ok(planned.has(surface), `${surface} is missing from the erasure plan`);
  }
  assert.equal(planned.size, RETENTION_SURFACES.length);
});

test("the residue statement names the blocked surfaces and the ticket that unblocks them", () => {
  // The receipt goes to a candidate. Claiming a clean erasure while the
  // verbatim quote is still in the ledger would be the false statement
  // this design exists to avoid.
  const residue = summarizeCandidateDataErasureResidue(planCandidateDataErasure("retention_expiry"));
  assert.equal(residue.anyResidue, true);
  const blocked = residue.surfaces.map((step) => step.surface);
  assert.ok(blocked.includes("evidence_outcomes"));
  assert.ok(blocked.includes("candidate_decisions"));
  assert.match(residue.statement, /AF-91/);
  assert.match(residue.statement, /append-only/);
});

test("blocked surfaces are never offered as erasable", () => {
  // A caller iterating erasableSurfaces must not be handed a surface whose
  // UPDATE the database will reject.
  for (const step of erasableSurfaces(planCandidateDataErasure("retention_expiry"))) {
    assert.notEqual(step.method, "blocked_append_only");
    assert.notEqual(step.method, "not_candidate_data");
  }
});
