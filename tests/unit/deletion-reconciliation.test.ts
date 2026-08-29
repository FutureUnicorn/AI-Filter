import assert from "node:assert/strict";
import test from "node:test";

import { planRetention, reconcileRetention } from "../../packages/domain/src/index.ts";
import type { RetentionResidue } from "../../packages/domain/src/index.ts";

// AF-63: "Scheduled job confirms every store that should be empty
// actually is; produces a reconciliation report so deletion drift is
// caught, not assumed."

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-29T12:00:00.000Z");
const PLAN = planRetention({ organizationId: ORG, windowDays: 30 }, NOW);

const CLASSIFIED_TABLES = [
  "file_intakes",
  "canonical_text_extractions",
  "import_rows",
  "applications",
  "evidence_outcomes",
  "candidate_decisions",
  "audit_events",
  "organizations",
  "users",
  "memberships",
  "roles"
];

function residue(overrides: Partial<RetentionResidue> = {}): RetentionResidue {
  return { rowsPastCutoffBySurface: {}, observedTables: CLASSIFIED_TABLES, ...overrides };
}

function kinds(report: ReturnType<typeof reconcileRetention>): readonly string[] {
  return report.findings.map((finding) => finding.kind);
}

test("an empty schema past the cutoff reconciles clean", () => {
  const report = reconcileRetention(PLAN, residue());
  assert.equal(report.clean, true);
  assert.deepEqual(report.findings, []);
  assert.match(report.statement, /no table is unclassified/);
});

test("a table the plan does not classify is reported, even with zero rows", () => {
  // The failure this job really guards against. A reconciliation driven
  // only by a hand-maintained surface list inherits that list's blind
  // spot: a migration adding candidate text would be invisible to it.
  const report = reconcileRetention(
    PLAN,
    residue({ observedTables: [...CLASSIFIED_TABLES, "candidate_notes"] })
  );
  assert.ok(kinds(report).includes("unclassified_surface"));
  assert.equal(report.clean, false, "an unclassified table is unreviewed, which is not clean");
  const finding = report.findings.find((f) => f.kind === "unclassified_surface");
  assert.equal(finding?.surface, "candidate_notes");
  assert.match(finding?.detail ?? "", /Classify it in RETENTION_SURFACES or add it to the exempt list/);
});

test("an unclassified table is flagged whether or not it holds rows", () => {
  // Zero rows today is not evidence of safety -- it is evidence the
  // feature has not been used yet.
  const empty = reconcileRetention(PLAN, residue({ observedTables: [...CLASSIFIED_TABLES, "candidate_notes"] }));
  const full = reconcileRetention(
    PLAN,
    residue({ observedTables: [...CLASSIFIED_TABLES, "candidate_notes"], rowsPastCutoffBySurface: { candidate_notes: 900 } })
  );
  assert.ok(kinds(empty).includes("unclassified_surface"));
  assert.ok(kinds(full).includes("unclassified_surface"));
  assert.equal(full.findings.find((f) => f.kind === "unclassified_surface")?.rowsPastCutoff, 900);
});

test("known non-candidate tables are exempt rather than noise", () => {
  // If organizations and users were reported every run, the report would
  // be ignored, and an actually-unclassified table would be lost in it.
  const report = reconcileRetention(PLAN, residue());
  assert.ok(!kinds(report).includes("unclassified_surface"));
});

test("residue in a surface the plan calls purgeable is a real finding", () => {
  const report = reconcileRetention(
    PLAN,
    residue({ rowsPastCutoffBySurface: { object_storage_documents: 12 } })
  );
  const finding = report.findings.find((f) => f.kind === "residue_present");
  assert.equal(finding?.surface, "object_storage_documents");
  assert.match(finding?.detail ?? "", /Either the purge did not run or it did not cover this surface/);
  assert.equal(report.clean, false);
});

test("blocked surfaces holding data are reported, and do NOT count as clean", () => {
  // The drift this job exists to surface. A report that went green while
  // candidate data sat there indefinitely would be worse than no report,
  // because someone would rely on it.
  const report = reconcileRetention(
    PLAN,
    residue({ rowsPastCutoffBySurface: { evidence_outcomes: 4, applications: 1 } })
  );
  assert.deepEqual(new Set(kinds(report)), new Set(["blocked_as_planned"]));
  assert.equal(report.clean, false, "expected-but-undeleted data is not a clean bill of health");
  assert.match(report.statement, /retain data past the cutoff because deletion is blocked/);
});

test("a blocked finding quotes the plan's own reason rather than inventing one", () => {
  const report = reconcileRetention(PLAN, residue({ rowsPastCutoffBySurface: { evidence_outcomes: 4 } }));
  const finding = report.findings.find((f) => f.surface === "evidence_outcomes");
  assert.match(finding?.detail ?? "", /cannot be redacted in place/);
});

test("audit_events holding rows is not a finding, because it holds no candidate data", () => {
  const report = reconcileRetention(PLAN, residue({ rowsPastCutoffBySurface: { audit_events: 5000 } }));
  assert.deepEqual(report.findings, []);
  assert.equal(report.clean, true);
});

test("the statement names every category present, so a reader need not read the findings array", () => {
  const report = reconcileRetention(
    PLAN,
    residue({
      observedTables: [...CLASSIFIED_TABLES, "candidate_notes"],
      rowsPastCutoffBySurface: { object_storage_documents: 3, evidence_outcomes: 4 }
    })
  );
  assert.match(report.statement, /should have been purged still hold data/);
  assert.match(report.statement, /not classified by the retention plan/);
  assert.match(report.statement, /deletion is blocked/);
});

test("the report carries the cutoff it was reconciled against", () => {
  // Without it, a stale report and a current one are indistinguishable.
  const report = reconcileRetention(PLAN, residue());
  assert.equal(report.cutoff, PLAN.cutoff);
  assert.equal(report.organizationId, ORG);
});
