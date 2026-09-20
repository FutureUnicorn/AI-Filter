import assert from "node:assert/strict";
import test from "node:test";

import { describeQualifiedPreservation, summarizeQualifiedPreservation } from "../../packages/domain/src/index.ts";
import { candidateAdjudicationSchema, metricSampleSchema } from "../../packages/contracts/src/index.ts";

// AF-56. The adjudication is external ground truth, and a contaminated
// one does not make this metric noisy -- it makes it agree with the thing
// it was supposed to be checking.

const APPLICATION_ID = "11111111-1111-4111-8111-111111111111";
const VALID = { applicationId: APPLICATION_ID, verdict: "strong", blindToWorkflowOutput: true } as const;

test("a well-formed adjudication parses", () => {
  assert.deepEqual(candidateAdjudicationSchema.parse(VALID), VALID);
});

test("an adjudication that does not state its independence is rejected", () => {
  // The whole premise of the metric. If the flag could be omitted, every
  // import that forgot would look independent.
  assert.equal(
    candidateAdjudicationSchema.safeParse({ applicationId: APPLICATION_ID, verdict: "strong" }).success,
    false
  );
});

test("independence must be a boolean, not a truthy string", () => {
  // "false" is truthy, and a CSV import is exactly where that arrives.
  assert.equal(candidateAdjudicationSchema.safeParse({ ...VALID, blindToWorkflowOutput: "false" }).success, false);
});

test("an unrecognised verdict is rejected rather than treated as not_strong", () => {
  // Silently bucketing an unknown verdict as not_strong shrinks the
  // denominator, which moves the safety metric upward.
  for (const verdict of ["maybe", "STRONG", ""]) {
    assert.equal(candidateAdjudicationSchema.safeParse({ ...VALID, verdict }).success, false);
  }
});

test("an unknown property on an adjudication is rejected", () => {
  assert.equal(candidateAdjudicationSchema.safeParse({ ...VALID, adjudicator: "panel-2" }).success, false);
});

test("what describeQualifiedPreservation returns validates as a MetricSample", () => {
  const preservation = summarizeQualifiedPreservation(
    [candidateAdjudicationSchema.parse(VALID)],
    [{ applicationId: APPLICATION_ID, evidence: { strength: "cited", citedCount: 3, uncitedCount: 0, totalCriteria: 3 } }]
  );
  const sample = describeQualifiedPreservation(preservation, 1);
  metricSampleSchema.parse(sample);
  assert.equal(sample.value, 1);
});

test("the AF-56 limitation code crosses the contract boundary", () => {
  // adjudication_not_independent was added to the closed set that
  // contracts mirrors. If the two drift, a report carrying the caveat is
  // rejected in transit -- and the caveat is the part that must not be
  // dropped.
  const preservation = summarizeQualifiedPreservation(
    [
      candidateAdjudicationSchema.parse(VALID),
      candidateAdjudicationSchema.parse({
        applicationId: "22222222-2222-4222-8222-222222222222",
        verdict: "strong",
        blindToWorkflowOutput: false
      })
    ],
    [{ applicationId: APPLICATION_ID, evidence: { strength: "cited", citedCount: 3, uncitedCount: 0, totalCriteria: 3 } }]
  );
  const sample = describeQualifiedPreservation(preservation, 1);
  assert.deepEqual(
    sample.limitations.map((limitation) => limitation.code),
    ["population_incomplete", "adjudication_not_independent"]
  );
  metricSampleSchema.parse(sample);
});

test("a suppressed preservation rate cannot smuggle a value past the contract", () => {
  const preservation = summarizeQualifiedPreservation(
    [candidateAdjudicationSchema.parse(VALID)],
    [{ applicationId: APPLICATION_ID, evidence: { strength: "cited", citedCount: 3, uncitedCount: 0, totalCriteria: 3 } }]
  );
  const suppressed = describeQualifiedPreservation(preservation, 30);
  assert.equal(suppressed.value, null);
  metricSampleSchema.parse(suppressed);
  assert.equal(metricSampleSchema.safeParse({ ...suppressed, value: 1 }).success, false);
});
