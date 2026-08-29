import assert from "node:assert/strict";
import test from "node:test";

import { describeReviewTimeReduction } from "../../packages/domain/src/index.ts";
import { metricSampleSchema, reviewTimeBaselineSchema } from "../../packages/contracts/src/index.ts";

// AF-55. The baseline is the one number in the review-time comparison that
// does not originate inside the system, so it is the one that needs a
// boundary validator.

const VALID = { source: "employer_reported", medianActiveMs: 600_000 } as const;

test("a well-formed employer baseline parses", () => {
  assert.deepEqual(reviewTimeBaselineSchema.parse(VALID), VALID);
});

test("a zero or negative baseline is rejected at the boundary", () => {
  // Not merely invalid: a zero baseline divides by zero and produces an
  // infinite reduction, which metricSampleSchema would then reject a layer
  // later with a message about finiteness that points nowhere near the
  // cause.
  for (const medianActiveMs of [0, -1]) {
    assert.equal(reviewTimeBaselineSchema.safeParse({ ...VALID, medianActiveMs }).success, false);
  }
});

test("a baseline with no stated source is rejected", () => {
  // The whole point of the field. If it could be omitted, every baseline of
  // unknown provenance would arrive looking like a measured one.
  assert.equal(reviewTimeBaselineSchema.safeParse({ medianActiveMs: VALID.medianActiveMs }).success, false);
  assert.equal(reviewTimeBaselineSchema.safeParse({ ...VALID, source: "assumed" }).success, false);
});

test("an unknown property on a baseline is rejected", () => {
  assert.equal(reviewTimeBaselineSchema.safeParse({ ...VALID, confidence: "high" }).success, false);
});

test("what describeReviewTimeReduction returns validates as a MetricSample", () => {
  const sample = describeReviewTimeReduction(
    { medianActiveMs: 300_000, sampleSize: 20, population: 20, truncatedSpanCount: 0 },
    reviewTimeBaselineSchema.parse(VALID),
    10
  );
  metricSampleSchema.parse(sample);
  assert.equal(sample.value, 0.5);
});

test("the AF-55 limitation code crosses the contract boundary", () => {
  // baseline_self_reported was added to a closed set that contracts mirrors
  // via z.enum(METRIC_LIMITATION_CODES). If the two ever drift, a report
  // carrying the caveat would be rejected in transit and the caveat is
  // exactly what must not get dropped.
  const sample = describeReviewTimeReduction(
    { medianActiveMs: 300_000, sampleSize: 20, population: 20, truncatedSpanCount: 0 },
    reviewTimeBaselineSchema.parse(VALID),
    10
  );
  assert.deepEqual(
    sample.limitations.map((limitation) => limitation.code),
    ["baseline_self_reported"]
  );
  metricSampleSchema.parse(sample);
});

test("a suppressed review-time reduction cannot smuggle a value past the contract", () => {
  // metricSampleSchema refuses a value whose own sample does not support
  // it. Asserted here rather than only in AF-60's own tests because this is
  // the headline metric, and it is the one someone would be tempted to
  // hand-build for a demo.
  const suppressed = describeReviewTimeReduction(
    { medianActiveMs: 300_000, sampleSize: 2, population: 20, truncatedSpanCount: 0 },
    reviewTimeBaselineSchema.parse(VALID),
    10
  );
  assert.equal(suppressed.value, null);
  metricSampleSchema.parse(suppressed);
  assert.equal(metricSampleSchema.safeParse({ ...suppressed, value: 0.5 }).success, false);
});
