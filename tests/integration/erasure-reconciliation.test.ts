import assert from "node:assert/strict";
import test from "node:test";

import { probeErasedCandidateReconciliation } from "../../packages/db/src/index.ts";
import { planRetention, reconcileRetention } from "../../packages/domain/src/index.ts";

// REV-002 / AF-62 / AF-63.
// A candidate whose data was completely erased must not be reported as
// blocked_as_planned residue in reconciliation. The redactable surfaces
// (file_intakes, canonical_text_extractions, import_rows, applications)
// survive as empty shells to satisfy foreign keys and audit metadata,
// but hold no candidate text. Counting them as blocked residue teaches
// operators to ignore retention reports.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];
const NOW = new Date("2026-09-01T00:00:00.000Z");

function requireDatabase(): string {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises retention reconciliation against real migrations. See README.md."
    );
  }
  return DATABASE_URL;
}

test("erasing a candidate completely clears residue on redactable surfaces and reconciles clean", async () => {
  const url = requireDatabase();
  const observed = await probeErasedCandidateReconciliation(url, NOW);

  // Before erasure: all 4 surfaces hold candidate data and are counted.
  assert.equal(observed.residueBeforeErasure.rowsPastCutoffBySurface["applications"], 1);
  assert.equal(observed.residueBeforeErasure.rowsPastCutoffBySurface["file_intakes"], 1);
  assert.equal(observed.residueBeforeErasure.rowsPastCutoffBySurface["canonical_text_extractions"], 1);
  assert.equal(observed.residueBeforeErasure.rowsPastCutoffBySurface["import_rows"], 1);

  const reportBefore = reconcileRetention(
    planRetention({ organizationId: observed.organizationId, windowDays: 30 }, NOW),
    observed.residueBeforeErasure
  );
  assert.equal(reportBefore.clean, false, "un-erased data must not reconcile clean");

  // After complete erasure: all 4 redactable surfaces report 0 rows past cutoff.
  assert.equal(
    observed.residueAfterErasure.rowsPastCutoffBySurface["applications"],
    0,
    "redacted applications must not count as residue"
  );
  assert.equal(
    observed.residueAfterErasure.rowsPastCutoffBySurface["file_intakes"],
    0,
    "redacted file intakes must not count as residue"
  );
  assert.equal(
    observed.residueAfterErasure.rowsPastCutoffBySurface["canonical_text_extractions"],
    0,
    "redacted canonical text extractions must not count as residue"
  );
  assert.equal(
    observed.residueAfterErasure.rowsPastCutoffBySurface["import_rows"],
    0,
    "redacted import rows must not count as residue"
  );

  const reportAfter = reconcileRetention(
    planRetention({ organizationId: observed.organizationId, windowDays: 30 }, NOW),
    observed.residueAfterErasure
  );
  assert.equal(reportAfter.clean, true, "an organization with all candidate data erased must reconcile clean");
  assert.deepEqual(reportAfter.findings, []);
  assert.equal(
    reportAfter.statement,
    "Every surface the retention plan covers is empty past the cutoff, and no table is unclassified."
  );
});

test("erasing a candidate with evidence outcomes leaves only the append-only ledger blocked as planned", async () => {
  const url = requireDatabase();
  const observed = await probeErasedCandidateReconciliation(url, NOW);

  // The 4 redactable surfaces are cleared, but evidence_outcomes survives
  assert.equal(observed.residueWithAppendOnlyOutcome.rowsPastCutoffBySurface["applications"], 0);
  assert.equal(observed.residueWithAppendOnlyOutcome.rowsPastCutoffBySurface["file_intakes"], 0);
  assert.equal(observed.residueWithAppendOnlyOutcome.rowsPastCutoffBySurface["canonical_text_extractions"], 0);
  assert.equal(observed.residueWithAppendOnlyOutcome.rowsPastCutoffBySurface["import_rows"], 0);
  assert.equal(
    observed.residueWithAppendOnlyOutcome.rowsPastCutoffBySurface["evidence_outcomes"],
    1,
    "append-only evidence outcomes must still be counted"
  );

  const report = reconcileRetention(
    planRetention({ organizationId: observed.organizationId, windowDays: 30 }, NOW),
    observed.residueWithAppendOnlyOutcome
  );
  assert.equal(report.clean, false, "surviving append-only evidence outcomes must not reconcile clean");
  const blocked = report.findings.filter((f) => f.kind === "blocked_as_planned");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.surface, "evidence_outcomes");
  assert.match(
    report.statement,
    /1 surface\(s\) retain data past the cutoff because deletion is blocked: evidence_outcomes/
  );
});
