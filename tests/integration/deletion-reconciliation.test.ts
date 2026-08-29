import assert from "node:assert/strict";
import test from "node:test";

import { probeRetentionReconciliation } from "../../packages/db/src/index.ts";
import { planRetention, reconcileRetention } from "../../packages/domain/src/index.ts";

// AF-63. The job's central claim is that it notices a table nobody
// classified. That only means anything if the table list comes from the
// live schema rather than from the same hand-maintained list the plan
// uses -- so it is proved against a real database containing a table
// created behind the plan's back.

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
