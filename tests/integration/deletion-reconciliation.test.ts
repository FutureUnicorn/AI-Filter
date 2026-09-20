import assert from "node:assert/strict";
import test from "node:test";

import {
  probeRetentionExternalCountGuards,
  probeRetentionReconciliation
} from "../../packages/db/src/index.ts";
import { planRetention, reconcileRetention } from "../../packages/domain/src/index.ts";

// AF-63. The job's central claim is that it notices a table nobody
// classified. That only means anything if the table list comes from the
// live schema rather than from the same hand-maintained list the plan
// uses -- so it is proved against a real database containing a table
// created behind the plan's back.
//
// REV-001 added the second half of that claim: the job must also notice a
// surface nobody measured. Those assertions are deliberately here rather
// than in the unit file, because the defect was precisely that the live
// path could not reach a branch the unit tests reached by hand.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];
const NOW = new Date("2027-01-01T00:00:00.000Z");

function requireDatabase(): string {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "reads a live information_schema rather than a fixture. See README.md."
    );
  }
  return DATABASE_URL;
}

test("a table added behind the plan's back is reported as unclassified", async () => {
  const url = requireDatabase();
  const { residue, organizationId } = await probeRetentionReconciliation(url, NOW.toISOString());

  assert.ok(
    residue.observedTables.includes("recruiter_scratch_notes"),
    "the observer must read the live schema, not a fixed list"
  );

  const report = reconcileRetention(planRetention({ organizationId, windowDays: 30 }, NOW), residue);
  const finding = report.findings.find(
    (candidate) => candidate.kind === "unclassified_surface" && candidate.surface === "recruiter_scratch_notes"
  );
  assert.ok(finding !== undefined, "a new table holding candidate text must not reconcile silently");
  assert.equal(report.clean, false);
});

test("real undeleted candidate data is counted and attributed to the right surface", async () => {
  const url = requireDatabase();
  const { residue, organizationId } = await probeRetentionReconciliation(url, NOW.toISOString());

  assert.equal(residue.rowsPastCutoffBySurface["applications"], 1);
  assert.equal(residue.rowsPastCutoffBySurface["evidence_outcomes"], 1);
  assert.equal(residue.rowsPastCutoffBySurface["canonical_text_extractions"], 1);
  assert.equal(residue.rowsPastCutoffBySurface["file_intakes"], 1);

  const report = reconcileRetention(planRetention({ organizationId, windowDays: 30 }, NOW), residue);
  const blocked = report.findings
    .filter((finding) => finding.kind === "blocked_as_planned")
    .map((finding) => finding.surface);
  assert.ok(blocked.includes("evidence_outcomes"));
  assert.ok(blocked.includes("applications"));
  assert.equal(report.clean, false, "candidate data past the cutoff is never a clean bill of health");
});

test("another tenant's undeleted data is not counted against this one", async () => {
  // canonical_text_extractions carries no organization_id of its own and
  // is reached through file_intakes. A global count would make one noisy
  // tenant look like everyone's problem -- and would also be a
  // cross-tenant read in a report handed to one customer.
  const url = requireDatabase();
  const { residue } = await probeRetentionReconciliation(url, NOW.toISOString());
  // The fixture gives tenant B one intake and one extraction. Tenant A
  // has exactly one of each, so a leaked count would read as 2.
  assert.equal(residue.rowsPastCutoffBySurface["file_intakes"], 1);
  assert.equal(residue.rowsPastCutoffBySurface["canonical_text_extractions"], 1);
});

test("an empty tenant reconciles clean, so a clean result is reachable at all", async () => {
  // Without this, every assertion above would still pass if the report
  // were hard-wired to find problems.
  //
  // residueBeforeAnyData is the one observation in the fixture that
  // measures every surface, object storage included, because the caller
  // supplied that listing. That is now what "clean" costs.
  const url = requireDatabase();
  const { residueBeforeAnyData, organizationId } = await probeRetentionReconciliation(url, NOW.toISOString());
  for (const count of Object.values(residueBeforeAnyData.rowsPastCutoffBySurface)) {
    assert.equal(count, 0);
  }
  const report = reconcileRetention(
    planRetention({ organizationId, windowDays: 30 }, NOW),
    residueBeforeAnyData
  );
  assert.equal(report.clean, true, "a tenant with no data must be able to reconcile clean");
  assert.deepEqual(report.findings, []);
});

// ---- REV-001 ----

test("object storage is never counted by the live observer, and the report says so", async () => {
  // The defect, stated as a test. object_storage_documents is the only
  // surface AF-61 calls purgeable, nothing in this repo counts blob
  // objects, and `rows ?? 0` turned that silence into a measured zero.
  const url = requireDatabase();
  const { residue, organizationId } = await probeRetentionReconciliation(url, NOW.toISOString());

  assert.ok(
    !residue.observedSurfaces.includes("object_storage_documents"),
    "nothing in this repo counts blob objects, so the observer must not claim it measured them"
  );
  assert.equal(residue.rowsPastCutoffBySurface["object_storage_documents"], undefined);

  const report = reconcileRetention(planRetention({ organizationId, windowDays: 30 }, NOW), residue);
  const finding = report.findings.find(
    (candidate) => candidate.kind === "not_observed" && candidate.surface === "object_storage_documents"
  );
  assert.ok(finding !== undefined, "an unmeasured purgeable surface must produce a finding of its own");
  assert.equal(finding?.rowsPastCutoff, undefined, "no number, because no measurement");
  assert.match(report.statement, /were not measured by this run/);
});

test("a tenant with CVs still in blob storage reaches residue_present through the live observer", async () => {
  // The branch the review found unreachable. The count comes through the
  // real observeRetentionResidue rather than a hand-built residue object,
  // which is the only way this proves the live path can get there.
  const url = requireDatabase();
  const { residueWithObjectStorageResidue, organizationId } = await probeRetentionReconciliation(
    url,
    NOW.toISOString()
  );

  assert.ok(residueWithObjectStorageResidue.observedSurfaces.includes("object_storage_documents"));
  assert.equal(residueWithObjectStorageResidue.rowsPastCutoffBySurface["object_storage_documents"], 2);

  const report = reconcileRetention(
    planRetention({ organizationId, windowDays: 30 }, NOW),
    residueWithObjectStorageResidue
  );
  const finding = report.findings.find((candidate) => candidate.kind === "residue_present");
  assert.equal(finding?.surface, "object_storage_documents");
  assert.equal(finding?.rowsPastCutoff, 2);
  assert.equal(report.clean, false);
  assert.match(report.statement, /should have been purged still hold data/);
});

test("measuring object storage and finding it empty removes the finding rather than hiding it", async () => {
  // The counterpart to the test above, and the reason not_observed is a
  // finding rather than a permanent disclaimer: a caller who really does
  // list blob storage gets a report that can distinguish "purged" from
  // "never looked". Same tenant, same blocked surfaces, one difference.
  const url = requireDatabase();
  const { residue, residueWithPurgedObjectStorage, organizationId } = await probeRetentionReconciliation(
    url,
    NOW.toISOString()
  );
  const plan = planRetention({ organizationId, windowDays: 30 }, NOW);

  const unmeasured = reconcileRetention(plan, residue).findings.filter(
    (finding) => finding.surface === "object_storage_documents"
  );
  const purged = reconcileRetention(plan, residueWithPurgedObjectStorage).findings.filter(
    (finding) => finding.surface === "object_storage_documents"
  );
  assert.deepEqual(
    unmeasured.map((finding) => finding.kind),
    ["not_observed"]
  );
  assert.deepEqual(purged, [], "a surface measured and found empty needs no finding");
});

test("a plan surface whose table is absent from the schema is reported unmeasured, not empty", async () => {
  // Same root cause on a Postgres surface. observeRetentionResidue skips
  // a surface whose table is not in the schema, which is correct -- but
  // the skip used to leave no trace, and the missing count read as zero.
  // A schema behind on migrations is the ordinary way this happens.
  const url = requireDatabase();
  const { residueMissingSurfaceTable, organizationId } = await probeRetentionReconciliation(
    url,
    NOW.toISOString()
  );

  assert.ok(
    !residueMissingSurfaceTable.observedTables.includes("candidate_decisions"),
    "the fixture must take this observation before 0019_candidate_decisions.sql is applied"
  );
  assert.ok(!residueMissingSurfaceTable.observedSurfaces.includes("candidate_decisions"));

  const report = reconcileRetention(
    planRetention({ organizationId, windowDays: 30 }, NOW),
    residueMissingSurfaceTable
  );
  const finding = report.findings.find(
    (candidate) => candidate.kind === "not_observed" && candidate.surface === "candidate_decisions"
  );
  assert.ok(finding !== undefined, "an absent table is an unmeasured surface, not an empty one");
  assert.equal(report.clean, false);
});

test("a surface that was measured is counted, not merely listed as observed", async () => {
  // candidate_decisions exists in the full fixture and holds one row past
  // the cutoff. Without this, observedSurfaces could be populated by
  // something that never ran a query and every assertion above would
  // still pass.
  const url = requireDatabase();
  const { residue, organizationId } = await probeRetentionReconciliation(url, NOW.toISOString());

  assert.ok(residue.observedSurfaces.includes("candidate_decisions"));
  assert.equal(residue.rowsPastCutoffBySurface["candidate_decisions"], 1);

  const report = reconcileRetention(planRetention({ organizationId, windowDays: 30 }, NOW), residue);
  const finding = report.findings.find((candidate) => candidate.surface === "candidate_decisions");
  assert.equal(finding?.kind, "blocked_as_planned");
  assert.equal(finding?.rowsPastCutoff, 1);
});

test("an external count is refused for anything the database can answer itself", async () => {
  // The one number in the residue that nothing corroborates. If a caller
  // could supply it for a table sitting right there, the report would
  // look measured while saying whatever the caller wanted.
  const url = requireDatabase();
  const guards = await probeRetentionExternalCountGuards(url, NOW.toISOString());

  assert.match(
    guards.refusedSelfCountedSurface ?? "",
    /refusing an external count for "file_intakes", which this function counts from the database itself/
  );
  assert.match(
    guards.refusedExistingTable ?? "",
    /refusing an external count for "roles", which is a table in schema "recon_guard_/
  );
});

test("an external count that is not a non-negative integer is refused, not recorded as zero", async () => {
  // A NaN reaching the map would mark the surface observed and then read
  // as "no residue" -- the same failure this whole field exists to close,
  // arriving through the fix instead of around it.
  const url = requireDatabase();
  const guards = await probeRetentionExternalCountGuards(url, NOW.toISOString());

  assert.match(guards.refusedNonInteger ?? "", /must be a non-negative safe integer, got: NaN/);
  assert.match(guards.refusedNegative ?? "", /must be a non-negative safe integer, got: -1/);
});

test("a valid external count is accepted, so the guards above are not simply rejecting everything", async () => {
  const url = requireDatabase();
  const guards = await probeRetentionExternalCountGuards(url, NOW.toISOString());

  assert.equal(guards.acceptedUnobservableSurface.rowsPastCutoffBySurface["object_storage_documents"], 7);
  assert.ok(guards.acceptedUnobservableSurface.observedSurfaces.includes("object_storage_documents"));
});
