import assert from "node:assert/strict";
import test from "node:test";

import {
  describeQualifiedPreservation,
  summarizeQualifiedPreservation
} from "../../packages/domain/src/index.ts";
import type {
  CandidateAdjudication,
  EvidenceStrengthSummary,
  MetricSample,
  SurfacedCandidate
} from "../../packages/domain/src/index.ts";

// AF-56: "Percentage of independently-adjudicated strong candidates who
// were also surfaced by the evidence workflow. Target >= 95%; this is
// the North Star safety metric."

const CITED: EvidenceStrengthSummary = { strength: "cited", citedCount: 4, uncitedCount: 1, totalCriteria: 5 };
const WEAK: EvidenceStrengthSummary = { strength: "weak", citedCount: 1, uncitedCount: 4, totalCriteria: 5 };
const NONE: EvidenceStrengthSummary = { strength: "none", citedCount: 0, uncitedCount: 5, totalCriteria: 5 };

function strong(applicationId: string, blindToWorkflowOutput = true): CandidateAdjudication {
  return { applicationId, verdict: "strong", blindToWorkflowOutput };
}

function surfaced(applicationId: string, evidence: EvidenceStrengthSummary | null): SurfacedCandidate {
  return { applicationId, evidence };
}

function codes(sample: MetricSample): readonly string[] {
  return sample.limitations.map((limitation) => limitation.code);
}

test("every strong candidate surfaced with evidence is full preservation", () => {
  const result = summarizeQualifiedPreservation(
    [strong("a"), strong("b")],
    [surfaced("a", CITED), surfaced("b", WEAK)]
  );
  assert.equal(result.preservationRate, 1);
  assert.equal(result.preserved, 2);
  assert.equal(result.adjudicatedStrong, 2);
});

test("weak-but-present evidence still counts as preserved", () => {
  // The claim is that the candidate reached a human with something to
  // check, not that the evidence was strong. Requiring `cited` here would
  // blame the workflow for a thin CV.
  const result = summarizeQualifiedPreservation([strong("a")], [surfaced("a", WEAK)]);
  assert.equal(result.preserved, 1);
});

test("reaching review with NO evidence is a miss, not a save", () => {
  // The failure this guards: if presence in the queue counted as
  // surfacing, a total extraction outage would report 100% preservation
  // while every reviewer saw a name and nothing else.
  const result = summarizeQualifiedPreservation(
    [strong("a"), strong("b")],
    [surfaced("a", CITED), surfaced("b", NONE)]
  );
  assert.equal(result.preservationRate, 0.5);
  assert.equal(result.missedWithoutEvidence, 1);
  assert.equal(result.missedAbsent, 0);
});

test("a null evidence summary is the same miss as strength none", () => {
  const result = summarizeQualifiedPreservation([strong("a")], [surfaced("a", null)]);
  assert.equal(result.missedWithoutEvidence, 1);
  assert.equal(result.preservationRate, 0);
});

test("never reaching review is a DIFFERENT miss from reaching it without evidence", () => {
  // Kept apart because they are fixed by different work: one is an intake
  // or pipeline loss, the other is extraction quality. A single "missed"
  // count tells nobody which.
  const result = summarizeQualifiedPreservation(
    [strong("a"), strong("b"), strong("c")],
    [surfaced("a", CITED), surfaced("b", NONE)]
  );
  assert.equal(result.missedAbsent, 1, "c never reached the queue");
  assert.equal(result.missedWithoutEvidence, 1, "b reached it empty-handed");
  assert.equal(result.preserved, 1);
});

test("an adjudicator who saw our output is excluded from the denominator, not counted against us", () => {
  const result = summarizeQualifiedPreservation(
    [strong("a"), strong("b", false)],
    [surfaced("a", CITED)]
  );
  assert.equal(result.adjudicatedStrong, 1, "only the blind adjudication is ground truth");
  assert.equal(result.excludedNotIndependent, 1);
  assert.equal(result.preservationRate, 1);
});

test("a wholly non-independent set yields no rate at all, not a perfect one", () => {
  // The specific way this metric could be gamed: adjudicate after seeing
  // the ranking and it agrees with itself by construction.
  const result = summarizeQualifiedPreservation([strong("a", false)], [surfaced("a", CITED)]);
  assert.equal(result.preservationRate, null);
  assert.equal(result.adjudicatedStrong, 0);
  assert.equal(result.excludedNotIndependent, 1);
});

test("an empty denominator reports null, never 1", () => {
  // A metric whose safest-looking value is what you get for doing no work
  // is worse than no metric.
  const result = summarizeQualifiedPreservation([], []);
  assert.equal(result.preservationRate, null);
});

test("candidates judged not_strong are ignored entirely", () => {
  // This is recall over the strong set. A not_strong candidate the
  // workflow dropped is not a preservation failure, and counting them
  // would dilute the denominator until the metric could not fail.
  const result = summarizeQualifiedPreservation(
    [strong("a"), { applicationId: "b", verdict: "not_strong", blindToWorkflowOutput: true }],
    [surfaced("a", CITED)]
  );
  assert.equal(result.adjudicatedStrong, 1);
  assert.equal(result.preservationRate, 1);
});

test("two verdicts for one candidate throws rather than double-counting", () => {
  assert.throws(
    () => summarizeQualifiedPreservation([strong("a"), strong("a")], [surfaced("a", CITED)]),
    /two adjudications for a/
  );
});

test("human decisions play no part: surfacing is not advancing", () => {
  // The most dangerous available shortcut is reading AF-51's `advance`
  // decisions as the surfacing signal. Nothing in this function's inputs
  // can express a decision, which is what makes that unavailable rather
  // than merely discouraged.
  const result = summarizeQualifiedPreservation([strong("a")], [surfaced("a", CITED)]);
  assert.equal(result.preserved, 1, "surfaced with evidence is preserved regardless of what a human then did");
});

test("the metric suppresses a preservation rate below the minimum sample", () => {
  const preservation = summarizeQualifiedPreservation([strong("a"), strong("b")], [surfaced("a", CITED), surfaced("b", CITED)]);
  const sample = describeQualifiedPreservation(preservation, 30);
  assert.equal(sample.value, null, "a 100% safety claim must not be reportable off two candidates");
  assert.ok(codes(sample).includes("below_minimum_sample"));
});

test("excluded adjudications are reported as a limitation, not just a smaller denominator", () => {
  const preservation = summarizeQualifiedPreservation(
    [strong("a"), strong("b", false)],
    [surfaced("a", CITED)]
  );
  const sample = describeQualifiedPreservation(preservation, 1);
  assert.ok(codes(sample).includes("adjudication_not_independent"));
  assert.match(sample.limitations.at(-1)?.detail ?? "", /agreement with ourselves/);
  assert.equal(sample.population, 2, "population keeps the excluded adjudication in scope");
  assert.equal(sample.sampleSize, 1);
});

test("a fully independent set carries no independence caveat", () => {
  const preservation = summarizeQualifiedPreservation([strong("a")], [surfaced("a", CITED)]);
  const sample = describeQualifiedPreservation(preservation, 1);
  assert.deepEqual(codes(sample), []);
});

test("the metric knows nothing about the 95% target", () => {
  // A threshold inside a metric creates pressure to report a number that
  // clears it. Whether the number cleared a bar is a separate question.
  const preservation = summarizeQualifiedPreservation([strong("a")], [surfaced("a", NONE)]);
  const sample = describeQualifiedPreservation(preservation, 1);
  assert.equal(sample.value, 0);
  assert.equal(sample.metric, "qualified_candidate_preservation");
  assert.ok(!Object.keys(sample).some((key) => /target|pass|meets/i.test(key)));
});
