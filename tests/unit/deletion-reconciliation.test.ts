import assert from "node:assert/strict";
import test from "node:test";

import { RETENTION_SURFACES, planRetention, reconcileRetention } from "../../packages/domain/src/index.ts";
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

// The default is "this run measured every surface", so the tests below
// exercise the classification rules rather than the observation gap. The
// gap gets its own tests, which subtract from this list on purpose.
function residue(overrides: Partial<RetentionResidue> = {}): RetentionResidue {
  return {
    rowsPastCutoffBySurface: {},
    observedSurfaces: [...RETENTION_SURFACES],
    observedTables: CLASSIFIED_TABLES,
    ...overrides
  };
}

function measuredExcept(...unmeasured: readonly string[]): readonly string[] {
  return RETENTION_SURFACES.filter((surface) => !unmeasured.includes(surface));
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

// ---- REV-001: a surface nobody measured must not read as empty ----
//
// An absent count and a measured zero are the same number. Before
// observedSurfaces, object_storage_documents -- the only surface the plan
// calls purgeable, and the one surface that does not live in Postgres --
// was never counted by anything, so `rows ?? 0` fired the `rows === 0`
// early continue every time, residue_present was unreachable against a
// live database, and a tenant whose CVs were still in blob storage
// reconciled clean: true.

test("a surface this run did not measure is reported, not assumed empty", () => {
  const report = reconcileRetention(
    PLAN,
    residue({ observedSurfaces: measuredExcept("object_storage_documents") })
  );
  const finding = report.findings.find((f) => f.kind === "not_observed");
  assert.equal(finding?.surface, "object_storage_documents");
  assert.equal(report.clean, false, "not looking is not the same as looking and finding nothing");
});

test("an unmeasured surface reports no row count rather than zero rows", () => {
  // Reporting 0 would be the same lie in a different field: a reader
  // would take it for a measurement.
  const report = reconcileRetention(
    PLAN,
    residue({ observedSurfaces: measuredExcept("object_storage_documents") })
  );
  const finding = report.findings.find((f) => f.kind === "not_observed");
  assert.equal(finding?.rowsPastCutoff, undefined);
  assert.match(finding?.detail ?? "", /did not measure object_storage_documents/);
  assert.match(finding?.detail ?? "", /the uploaded document itself/);
});

test("the statement names the unmeasured surfaces, so the sentence cannot read as clean", () => {
  const report = reconcileRetention(
    PLAN,
    residue({ observedSurfaces: measuredExcept("object_storage_documents", "candidate_decisions") })
  );
  assert.match(report.statement, /were not measured by this run/);
  assert.match(report.statement, /object_storage_documents/);
  assert.match(report.statement, /candidate_decisions/);
});

test("every plan surface unmeasured is every plan surface reported, none skipped", () => {
  // A guard that only covered object storage would leave the same hole
  // open for any Postgres surface whose table is missing from the schema.
  const report = reconcileRetention(PLAN, residue({ observedSurfaces: [] }));
  const unmeasured = new Set(report.findings.filter((f) => f.kind === "not_observed").map((f) => f.surface));
  const expected = new Set(RETENTION_SURFACES.filter((surface) => surface !== "audit_events"));
  assert.deepEqual(unmeasured, expected);
  assert.equal(report.clean, false);
});

test("a no_candidate_data surface is not reported as unmeasured, because a count would say nothing", () => {
  // audit_events holds nothing candidate-derived by construction, and
  // reconcileRetention discards its count even when it has one. Demanding
  // a measurement that is then thrown away would be noise on every run,
  // and noise is what makes a report get skimmed.
  const report = reconcileRetention(PLAN, residue({ observedSurfaces: measuredExcept("audit_events") }));
  assert.deepEqual(report.findings, []);
  assert.equal(report.clean, true);
});

test("residue in an unmeasured purgeable surface cannot be masked by a stale count", () => {
  // A count left in the map for a surface this run did not measure is
  // last run's number, not this one's. It must not suppress the finding.
  const report = reconcileRetention(
    PLAN,
    residue({
      observedSurfaces: measuredExcept("object_storage_documents"),
      rowsPastCutoffBySurface: { object_storage_documents: 40 }
    })
  );
  assert.deepEqual(
    report.findings.map((f) => f.kind),
    ["not_observed"]
  );
  assert.equal(report.findings[0]?.rowsPastCutoff, undefined);
});

test("an unclassified table nobody counted reports no row count rather than zero", () => {
  // The observer cannot tenant-scope a count on a table it does not know
  // the shape of, so it does not count one at all. The finding still
  // stands on the table's existence; what must not appear is "0 rows".
  const report = reconcileRetention(
    PLAN,
    residue({ observedTables: [...CLASSIFIED_TABLES, "candidate_notes"] })
  );
  const finding = report.findings.find((f) => f.kind === "unclassified_surface");
  assert.equal(finding?.surface, "candidate_notes");
  assert.equal(finding?.rowsPastCutoff, undefined);
});
