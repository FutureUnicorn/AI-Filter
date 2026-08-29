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
import type { RetentionPolicy } from "../../packages/domain/src/index.ts";

// AF-61: "Default retention window for raw candidate data (e.g. 30-90
// days), configurable per contract, applied consistently across object
// storage, canonical text, and derived indexes."

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-29T12:00:00.000Z");

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

test("the append-only evidence store is named as the root blocker", () => {
  // Both DELETE and UPDATE are rejected, so the quote can be neither
  // removed nor redacted in place. Everything else is downstream of it.
  const plan = planRetention(policy(), NOW);
  const evidence = plan.surfaces.find((surface) => surface.surface === "evidence_outcomes");
  assert.equal(evidence?.disposition, "blocked_append_only");
  assert.match(evidence?.detail ?? "", /cannot be redacted in place/);
});

test("the candidate's filename is recognised as PII, not just a label", () => {
  // Easy to overlook, and routinely "Firstname_Lastname_CV.pdf".
  const plan = planRetention(policy(), NOW);
  const intakes = plan.surfaces.find((surface) => surface.surface === "file_intakes");
  assert.match(intakes?.holds ?? "", /declared_filename/);
});

test("audit_events is listed as holding no candidate data, so its exclusion is stated not omitted", () => {
  const plan = planRetention(policy(), NOW);
  const audit = plan.surfaces.find((surface) => surface.surface === "audit_events");
  assert.equal(audit?.disposition, "no_candidate_data");
});

test("the survival summary produces a sentence a privacy notice can use truthfully", () => {
  // The point of the ticket. A privacy notice written from an optimistic
  // retention policy is a false statement to a candidate, which is worse
  // than an honest "we keep quotes indefinitely".
  const summary = summarizeSurvivingCandidateData(planRetention(policy(), NOW));
  assert.equal(summary.anySurvives, true);
  assert.match(summary.statement, /still\s+retained and cannot currently be deleted/);
  assert.match(summary.statement, /evidence_outcomes \(citation quotes/);
  assert.match(summary.statement, /applications \(candidate_full_name/);
  assert.ok(
    !summary.statement.includes("is deleted"),
    "the summary must not claim deletion happens while anything survives"
  );
});

test("the survival summary lists every blocked surface, not just the append-only ones", () => {
  const summary = summarizeSurvivingCandidateData(planRetention(policy(), NOW));
  const named = summary.surfaces.map((surface) => surface.surface);
  for (const expected of ["evidence_outcomes", "candidate_decisions", "applications", "canonical_text_extractions"]) {
    assert.ok(named.includes(expected as never), `${expected} survives but is not reported`);
  }
});
