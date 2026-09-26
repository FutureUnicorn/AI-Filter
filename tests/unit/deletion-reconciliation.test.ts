import assert from "node:assert/strict";
import test from "node:test";

import {
  RETENTION_SURFACES,
  assertRetentionExemptionsAreLive,
  planRetention,
  reconcileRetention
} from "../../packages/domain/src/index.ts";
import type { RetentionPlan, RetentionResidue } from "../../packages/domain/src/index.ts";

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
  // REV-001: three of these were exempt and one was absent from the plan
  // entirely, and all four keep a candidate's application identifier.
  // audit_samples is the one that stays exempt, so leaving it here keeps
  // the exemption exercised rather than merely declared.
  "evidence_extraction_runs",
  "audit_sample_members",
  "review_timing_spans",
  "audit_samples",
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

// ---- REV-001: the surfaces that keep the identifier ----
//
// This test asserted the opposite and passed, which is what a test
// pinning a defect looks like. AF-61 classified audit_events as holding
// nothing candidate-derived, and the classification was true about
// candidate TEXT and false about identifiers, so the reconciler was
// correctly implementing a wrong rule. Three more surfaces were exempt
// or absent for the same reason.

test("audit_events holding rows past the cutoff is a finding, because it keeps the identifier", () => {
  const report = reconcileRetention(PLAN, residue({ rowsPastCutoffBySurface: { audit_events: 5000 } }));
  const finding = report.findings.find((f) => f.surface === "audit_events");
  assert.equal(finding?.kind, "blocked_as_planned");
  assert.equal(finding?.rowsPastCutoff, 5000);
  assert.equal(report.clean, false, "rows a tenant cannot delete are not a clean bill of health");
});

test("no tenant reconciles clean while any identifier surface still holds rows", () => {
  // The fixture Sai asked for, stated as the property rather than as one
  // table: every surface that keeps an application identifier, each on
  // its own, has to be enough to take the report out of clean.
  for (const surface of [
    "audit_events",
    "evidence_extraction_runs",
    "audit_sample_members",
    "review_timing_spans"
  ] as const) {
    const report = reconcileRetention(PLAN, residue({ rowsPastCutoffBySurface: { [surface]: 1 } }));
    assert.equal(report.clean, false, `${surface} holding a row past the cutoff must not reconcile clean`);
    assert.equal(
      report.findings.find((f) => f.surface === surface)?.kind,
      "blocked_as_planned",
      `${surface} must be reported by name, not merely counted`
    );
  }
});

test("no exemption shadows a classified surface", () => {
  // The failure this catches is silent: a table in both lists is
  // classified, described in the privacy notice, and skipped by the
  // reconciler, with each half looking right on its own. That is exactly
  // the state evidence_extraction_runs was in.
  assertRetentionExemptionsAreLive();
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
  // Every one of them now. The exclusion here was audit_events, on the
  // strength of a disposition it no longer carries.
  const expected = new Set(RETENTION_SURFACES);
  assert.deepEqual(unmeasured, expected);
  assert.equal(report.clean, false);
});

test("the no_candidate_data branch still skips the unmeasured check, on a plan that reaches it", () => {
  // No surface carries that disposition any more, so planRetention
  // cannot reach this branch. The branch stays rather than being
  // deleted: the reasoning is sound for a surface that genuinely holds
  // nothing, RetentionPlan is exported so a caller can build one, and
  // deleting it would leave the rule undocumented and untested against
  // the day a surface qualifies. Exercised on a hand-built plan, which
  // is the honest way to keep an unreachable branch covered.
  const plan: RetentionPlan = {
    ...PLAN,
    surfaces: PLAN.surfaces.map((surface) =>
      surface.surface === "audit_events"
        ? { ...surface, disposition: "no_candidate_data" as const }
        : surface
    )
  };
  const report = reconcileRetention(plan, residue({ observedSurfaces: measuredExcept("audit_events") }));
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
