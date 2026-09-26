import assert from "node:assert/strict";
import test from "node:test";

import {
  RETENTION_ABSOLUTE_MAX_DAYS,
  RETENTION_DEFAULT_DAYS,
  RETENTION_STANDARD_MAX_DAYS,
  RETENTION_SURFACES,
  computeRetentionCutoff,
  planRetention,
  summarizeSurvivingCandidateData,
  validateRetentionPolicy
} from "../../packages/domain/src/index.ts";
import type { RetentionEnforcement, RetentionPlan, RetentionPolicy } from "../../packages/domain/src/index.ts";

// AF-61: "Default retention window for raw candidate data (e.g. 30-90
// days), configurable per contract, applied consistently across object
// storage, canonical text, and derived indexes."

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-29T12:00:00.000Z");

// The truth today: nothing runs a purge. Stated once, by name, so no test
// gets the enforced wording by accident.
const NOT_ENFORCED: RetentionEnforcement = { automatedDeletionActive: false };
const ENFORCED: RetentionEnforcement = { automatedDeletionActive: true };

function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return { organizationId: ORG, windowDays: RETENTION_DEFAULT_DAYS, ...overrides };
}

test("the default window is the SHORT end of the stated range", () => {
  // A default that errs long keeps candidate data by accident, and
  // nobody notices data that is still there.
  assert.equal(RETENTION_DEFAULT_DAYS, 30);
  assert.ok(RETENTION_DEFAULT_DAYS < RETENTION_STANDARD_MAX_DAYS);
});

test("a window beyond the standard range requires a contract reference", () => {
  // "Configurable per contract" means the contract is the thing that
  // authorises it. Without this, an unusually long retention is just a
  // config value nobody remembers setting.
  assert.throws(() => validateRetentionPolicy(policy({ windowDays: 180 })), /requires a contractReference/);
  assert.doesNotThrow(() =>
    validateRetentionPolicy(policy({ windowDays: 180, contractReference: "MSA-2026-014 s.7" }))
  );
});

test("a blank contract reference does not count as one", () => {
  assert.throws(
    () => validateRetentionPolicy(policy({ windowDays: 180, contractReference: "   " })),
    /requires a contractReference/
  );
});

test("a window within the standard range needs no contract reference", () => {
  assert.doesNotThrow(() => validateRetentionPolicy(policy({ windowDays: RETENTION_STANDARD_MAX_DAYS })));
});

test("nonsense windows are rejected rather than silently coerced", () => {
  for (const windowDays of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => validateRetentionPolicy(policy({ windowDays })), /positive whole number of days/);
  }
  assert.throws(
    () => validateRetentionPolicy(policy({ windowDays: RETENTION_ABSOLUTE_MAX_DAYS + 1, contractReference: "x" })),
    /exceeds the absolute maximum/
  );
});

test("the cutoff is computed from an explicit now, so one purge run cannot straddle midnight", () => {
  const cutoff = computeRetentionCutoff(policy({ windowDays: 30 }), NOW);
  assert.equal(cutoff, "2026-07-30T12:00:00.000Z");
  assert.equal(computeRetentionCutoff(policy({ windowDays: 30 }), NOW), cutoff, "same inputs, same answer");
});

test("every surface appears in the plan, always", () => {
  // A surface missing from a retention plan reads as "nothing to do
  // there" -- the same failure as a missing section in the audit report.
  const plan = planRetention(policy(), NOW);
  assert.deepEqual(
    plan.surfaces.map((surface) => surface.surface),
    [...RETENTION_SURFACES]
  );
});

test("every blocked surface says why, in words a non-engineer can act on", () => {
  const plan = planRetention(policy(), NOW);
  for (const surface of plan.surfaces) {
    if (surface.disposition === "purge" || surface.disposition === "no_candidate_data") {
      continue;
    }
    assert.ok(surface.detail.trim().length > 0, `${surface.surface} is blocked with no reason given`);
    assert.ok(surface.holds.trim().length > 0, `${surface.surface} does not say what it holds`);
  }
});

test("the append-only evidence store cannot be redacted, and is not the only root blocker", () => {
  // Both DELETE and UPDATE are rejected, so the quote can be neither
  // removed nor redacted in place. REV-003: it was called "the root
  // blocker", but three other append-only tables pin applications just
  // as hard, so unblocking it alone frees nothing.
  const plan = planRetention(policy(), NOW);
  const evidence = plan.surfaces.find((surface) => surface.surface === "evidence_outcomes");
  assert.equal(evidence?.disposition, "blocked_append_only");
  assert.match(evidence?.detail ?? "", /cannot be redacted in place/);
  assert.doesNotMatch(evidence?.detail ?? "", /\bthe root blocker\b/);
  for (const sibling of ["candidate_decisions", "audit_sample_members", "review_timing_spans"]) {
    assert.match(evidence?.detail ?? "", new RegExp(`\\b${sibling}\\b`), `the detail must name ${sibling}`);
  }
});

test("the applications blocker names all five blockers, not only the one Postgres reports", () => {
  // REV-003. Enumerated from pg_constraint over every migration, and each
  // proved by probe in the integration test on an application pinned by
  // that dependent alone. Four append-only tables hold an uncascaded FK
  // (23503), and import_rows' FK is ON DELETE SET NULL but its CHECK
  // refuses a processed row without an application_id (23514). A DELETE
  // reports whichever it checks first, so a detail written from error
  // messages rather than the schema understates the work.
  const plan = planRetention(policy(), NOW);
  const detail = plan.surfaces.find((surface) => surface.surface === "applications")?.detail ?? "";
  for (const [table, migration] of [
    ["evidence_outcomes", "0016_evidence_outcomes.sql"],
    ["candidate_decisions", "0019_candidate_decisions.sql"],
    ["audit_sample_members", "0020_audit_samples.sql"],
    ["review_timing_spans", "0021_review_timing.sql"],
    ["import_rows", "0015_applications_and_import_finalization.sql"]
  ] as const) {
    assert.match(detail, new RegExp(`\\b${table}\\b`), `the detail must name ${table}`);
    // By filename, never bare number: this branch has two 0009 files.
    assert.ok(detail.includes(migration), `the detail must cite ${table}'s migration as ${migration}`);
  }
  assert.match(detail, /\bfive\b/, "the count has to be stated, so a reader cannot take it as a sample");
  assert.doesNotMatch(detail, /\btwo\b/, "the old understated count must not survive anywhere in the text");
  assert.match(detail, /import_rows_check/, "the import_rows blocker is a CHECK, not the FK, and must say so");
  assert.match(
    detail,
    /import_rows must be purged before applications/,
    "the ordering is the actionable part: the SET NULL trips the CHECK otherwise"
  );
  assert.match(
    detail,
    /independently/,
    "naming them is not enough; the detail has to say that removing one leaves the others"
  );
});

test("import_rows says it must go before applications, from its own side too", () => {
  // A reader of the import_rows entry alone would otherwise see "purge"
  // and no hint that it gates another surface.
  const plan = planRetention(policy(), NOW);
  const rows = plan.surfaces.find((surface) => surface.surface === "import_rows");
  assert.equal(rows?.disposition, "purge");
  assert.match(rows?.detail ?? "", /purge import_rows first/);
});

test("the candidate's filename is recognised as PII, not just a label", () => {
  // Easy to overlook, and routinely "Firstname_Lastname_CV.pdf".
  const plan = planRetention(policy(), NOW);
  const intakes = plan.surfaces.find((surface) => surface.surface === "file_intakes");
  assert.match(intakes?.holds ?? "", /declared_filename/);
});

// REV-001: an identifier is candidate data for retention purposes.
//
// The previous version of this test asserted audit_events held nothing
// candidate-derived, which is what a test that encodes the defect looks
// like: it passed, and what it was pinning was the wrong
// classification. audit_events holds no candidate TEXT, which is what
// AF-21's redaction guarantees and all it guarantees. entity_type and
// entity_id are free text, and the identifier of a candidate's
// application is written there whenever a correction or a decision is
// recorded, which is two of the four audit actions.

test("audit_events survives holding the identifier, not classified as holding nothing", () => {
  const plan = planRetention(policy(), NOW);
  const audit = plan.surfaces.find((surface) => surface.surface === "audit_events");
  assert.equal(audit?.disposition, "blocked_append_only");
  assert.match(audit?.holds ?? "", /entity_id/);
  assert.match(audit?.detail ?? "", /DELETE and UPDATE are both rejected/);
});

test("evidence_extraction_runs is in the plan at all", () => {
  // It was absent entirely, and absent is how the inventory that finds
  // unaccounted tables missed it: that check reads pg_constraint, and
  // this table's link to an application is two text columns with no
  // foreign key between them.
  const plan = planRetention(policy(), NOW);
  const runs = plan.surfaces.find((surface) => surface.surface === "evidence_extraction_runs");
  assert.equal(runs?.disposition, "blocked_append_only");
  assert.match(runs?.holds ?? "", /entity_id/);
});

test("no surface is classified as holding nothing candidate-derived any more", () => {
  // Both surfaces that carried no_candidate_data carried it wrongly, for
  // the same reason: the classification asks "is there candidate text
  // here", and an identifier is not text. Keeping the disposition in the
  // type is deliberate, since a future surface may genuinely qualify,
  // but a new one should have to argue for it against this.
  const plan = planRetention(policy(), NOW);
  assert.deepEqual(
    plan.surfaces.filter((surface) => surface.disposition === "no_candidate_data").map((s) => s.surface),
    []
  );
});

test("the survival summary produces a sentence a privacy notice can use truthfully", () => {
  // The point of the ticket. A privacy notice written from an optimistic
  // retention policy is a false statement to a candidate, which is worse
  // than an honest "we keep quotes indefinitely".
  const summary = summarizeSurvivingCandidateData(planRetention(policy(), NOW), NOT_ENFORCED);
  assert.equal(summary.anySurvives, true);
  assert.match(summary.statement, /the following cannot currently be deleted/);
  assert.match(summary.statement, /evidence_outcomes \(citation quotes/);
  assert.match(summary.statement, /applications \(candidate_full_name/);
  assert.ok(
    !summary.statement.includes("is deleted"),
    "the summary must not claim deletion happens while anything survives"
  );
});

// REV-006: holds is what the privacy notice is built from, so a surface
// that understates what it keeps understates the notice. Enumerated from
// the columns each table actually has rather than from the existing
// wording, the same method that found five blockers rather than two.

test("every surface's holds names everything that surface keeps about the candidate", () => {
  const plan = planRetention(policy(), NOW);
  const holdsFor = (surface: string): string =>
    plan.surfaces.find((entry) => entry.surface === surface)?.holds ?? "";

  // 0017_evidence_corrections.sql adds correction_reason to
  // evidence_outcomes. It is free text a reviewer writes about the
  // candidate's evidence and the append-only trigger covers it, so it is
  // exactly as undeletable as the quote beside it.
  assert.match(holdsFor("evidence_outcomes"), /citation quotes/);
  assert.match(holdsFor("evidence_outcomes"), /correction_reason/);

  // storage_key is built as ".../pending/<uuid>-<declaredFilename>", so
  // redacting declared_filename alone leaves the candidate's filename in
  // the row. Found by sweeping holds against the columns, not reported.
  assert.match(holdsFor("file_intakes"), /declared_filename/);
  assert.match(holdsFor("file_intakes"), /storage_key/);
});

test("the notice names the reviewer free text on both surfaces that carry it", () => {
  // candidate_decisions.rationale was already named; evidence_outcomes'
  // correction_reason is the same kind of content and was not. A candidate
  // told their quoted CV text is kept, but not that reviewers' written
  // remarks about them are kept too, has been given a partial answer.
  const summary = summarizeSurvivingCandidateData(planRetention(policy(), NOW), NOT_ENFORCED);
  assert.match(summary.statement, /correction_reason/);
  assert.match(summary.statement, /rationale/);
});

test("the survival summary lists exactly the surfaces that survive, no more and no fewer", () => {
  // deepEqual, not a list of includes checks. The earlier version
  // asserted four surfaces were present and said nothing about a fifth,
  // so it kept passing while the plan named canonical_text_extractions
  // as surviving something it is not subject to. Overstating what is
  // retained is a false statement to a candidate in the same way
  // understating it is, so the set has to be exact in both directions.
  // Proved against the database in
  // tests/integration/retention-purge-blockers.test.ts.
  const summary = summarizeSurvivingCandidateData(planRetention(policy(), NOW), NOT_ENFORCED);
  assert.deepEqual(
    summary.surfaces.map((surface) => surface.surface),
    [
      "file_intakes",
      "applications",
      "evidence_outcomes",
      "candidate_decisions",
      // REV-001. Both append-only, both keeping the application
      // identifier, and both previously outside this list: one by a
      // wrong disposition and one by being absent from the plan.
      "audit_events",
      "evidence_extraction_runs"
    ]
  );
});

// ---- REV-005: the statement must describe what actually happens ----
//
// Nothing calls planRetention, nothing deletes on a schedule and no
// policy is stored, so no candidate data is deleted after any window. The
// old statement said "After the N-day retention window, the following ...
// is still retained", which tells a data subject that everything NOT
// listed is gone. The "is deleted" check above was already there and
// passed against that sentence, so on its own it proved nothing; these
// are the ones that fail against it.

test("with no deletion process running, the statement says nothing is deleted automatically", () => {
  const summary = summarizeSurvivingCandidateData(planRetention(policy(), NOW), NOT_ENFORCED);
  assert.equal(summary.automatedDeletionActive, false);
  assert.match(summary.statement, /not currently deleted automatically/);
  // The clause that stops the survivor list reading as the only thing kept.
  assert.match(summary.statement, /kept after the 30-day retention window until one does/);
});

test("with no deletion process running, nothing unlisted is implied to be gone", () => {
  const { statement } = summarizeSurvivingCandidateData(planRetention(policy(), NOW), NOT_ENFORCED);
  assert.doesNotMatch(statement, /\bis deleted\b/);
  assert.doesNotMatch(
    statement,
    /After the \d+-day retention window, the following/,
    "listing survivors after the window implies everything else was deleted at it"
  );
});

test("the branch planRetention cannot reach still never claims deletion without an executor", () => {
  // planRetention always carries blocked surfaces, so nothing survives only
  // on a hand-built plan. RetentionPlan is exported, so a caller can build
  // one, and this branch used to say "Raw candidate data is deleted".
  const reachable = planRetention(policy(), NOW);
  const nothingBlocked: RetentionPlan = {
    ...reachable,
    surfaces: reachable.surfaces.map((surface) => ({ ...surface, disposition: "purge" as const }))
  };
  const summary = summarizeSurvivingCandidateData(nothingBlocked, NOT_ENFORCED);
  assert.equal(summary.anySurvives, false);
  assert.doesNotMatch(summary.statement, /\bis deleted\b/);
  assert.match(summary.statement, /not currently deleted automatically/);
});

test("once deletion is enforced, the survivors are still named as the exception", () => {
  const summary = summarizeSurvivingCandidateData(planRetention(policy(), NOW), ENFORCED);
  assert.equal(summary.automatedDeletionActive, true);
  assert.match(summary.statement, /is deleted 30 days after intake, except the following/);
  assert.match(summary.statement, /evidence_outcomes \(citation quotes/);
  assert.deepEqual(
    summary.surfaces.map((surface) => surface.surface),
    [
      "file_intakes",
      "applications",
      "evidence_outcomes",
      "candidate_decisions",
      // REV-001. Both append-only, both keeping the application
      // identifier, and both previously outside this list: one by a
      // wrong disposition and one by being absent from the plan.
      "audit_events",
      "evidence_extraction_runs"
    ]
  );
});

test("the unqualified deletion sentence is reachable only when enforced and nothing survives", () => {
  const reachable = planRetention(policy(), NOW);
  const nothingBlocked: RetentionPlan = {
    ...reachable,
    surfaces: reachable.surfaces.map((surface) => ({ ...surface, disposition: "purge" as const }))
  };
  assert.equal(
    summarizeSurvivingCandidateData(nothingBlocked, ENFORCED).statement,
    "Raw candidate data is deleted 30 days after intake."
  );
});

test("the surfaces the ticket names by hand, canonical text and a derived index, can be purged", () => {
  // "Applied consistently across object storage, canonical text, and
  // derived indexes." All three of those are purgeable. The blocked
  // layer is the one the ticket does not mention. An earlier revision
  // had these two blocked, reasoning from their cascade through
  // file_intakes and never trying the direct DELETE the database
  // permits.
  const plan = planRetention(policy(), NOW);
  for (const surface of ["object_storage_documents", "canonical_text_extractions", "import_rows"]) {
    const entry = plan.surfaces.find((candidate) => candidate.surface === surface);
    assert.equal(entry?.disposition, "purge", `${surface} is not marked purgeable`);
  }
});

test("a purgeable surface still says what purging it costs", () => {
  // A disposition of "purge" is not the end of the thought. Deleting the
  // canonical text leaves evidence citations with no source to validate
  // against, and deleting import_rows breaks AF-32's per-row accounting.
  // Both are consequences to accept deliberately, not to discover.
  const plan = planRetention(policy(), NOW);
  const canonical = plan.surfaces.find((surface) => surface.surface === "canonical_text_extractions");
  assert.match(canonical?.detail ?? "", /no source text to\s+validate against/);
  const rows = plan.surfaces.find((surface) => surface.surface === "import_rows");
  assert.match(rows?.detail ?? "", /every input row is accounted for/);
});
