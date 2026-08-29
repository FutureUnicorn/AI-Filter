import assert from "node:assert/strict";
import test from "node:test";

import { describeReviewTimeReduction, summarizeReviewTiming } from "../../packages/domain/src/index.ts";
import type { MetricSample, ReviewTimeBaseline, ReviewTimingSpan } from "../../packages/domain/src/index.ts";

// AF-55: "Compare assisted review time against the employer's own
// baseline process. Target >= 50%."

const MEASURED: ReviewTimeBaseline = { source: "measured_preassist", medianActiveMs: 600_000 };
const REPORTED: ReviewTimeBaseline = { source: "employer_reported", medianActiveMs: 600_000 };

function assisted(medianActiveMs: number | null, sampleSize: number, population = sampleSize) {
  return { medianActiveMs, sampleSize, population, truncatedSpanCount: 0 };
}

function codes(sample: MetricSample): readonly string[] {
  return sample.limitations.map((limitation) => limitation.code);
}

test("half the baseline time reports a 0.5 reduction", () => {
  const sample = describeReviewTimeReduction(assisted(300_000, 20), MEASURED, 10);
  assert.equal(sample.value, 0.5);
  assert.equal(sample.metric, "review_time_reduction");
  assert.equal(sample.sampleSize, 20);
});

test("assisted review being SLOWER reports a negative reduction, not zero", () => {
  // The single most important thing this metric can say. Clamping at zero
  // is the obvious defensive move and it would render "we made review 20%
  // slower" as "no improvement" -- turning the one result that should stop
  // a rollout into a shrug.
  const sample = describeReviewTimeReduction(assisted(720_000, 20), MEASURED, 10);
  assert.equal(sample.value, -0.2);
});

test("no usable timing reports no value, never a zero reduction", () => {
  // summarizeReviewTiming returns null rather than 0 for an empty sample;
  // a 0 here would read as "the tool saved no time", which is a finding,
  // not an absence of one.
  const sample = describeReviewTimeReduction(assisted(null, 0, 12), MEASURED, 10);
  assert.equal(sample.value, null);
  assert.deepEqual(codes(sample), ["no_sample", "population_incomplete"]);
});

test("a sample below the minimum is suppressed rather than reported with a warning", () => {
  const sample = describeReviewTimeReduction(assisted(300_000, 3), MEASURED, 10);
  assert.equal(sample.value, null, "a 50% claim must not be reportable off three applications");
  assert.ok(codes(sample).includes("below_minimum_sample"));
});

test("an employer-reported baseline is labelled as such", () => {
  const sample = describeReviewTimeReduction(assisted(300_000, 20), REPORTED, 10);
  assert.equal(sample.value, 0.5);
  assert.deepEqual(codes(sample), ["baseline_self_reported"]);
  const [limitation] = sample.limitations;
  assert.match(limitation?.detail ?? "", /600000ms/);
  assert.match(limitation?.detail ?? "", /employer's own estimate/);
});

test("a measured baseline carries no self-reported caveat", () => {
  // The caveat has to be absent when it does not apply, or it becomes
  // boilerplate that readers learn to skip past on the reports where it
  // does.
  const sample = describeReviewTimeReduction(assisted(300_000, 20), MEASURED, 10);
  assert.deepEqual(codes(sample), []);
});

test("the self-reported caveat survives suppression", () => {
  // It describes how the comparison was built, not how much data there is.
  // A caveat that appeared and vanished with sample size would read as
  // being about sample size.
  const sample = describeReviewTimeReduction(assisted(300_000, 2), REPORTED, 10);
  assert.equal(sample.value, null);
  assert.ok(codes(sample).includes("baseline_self_reported"));
  assert.ok(codes(sample).includes("below_minimum_sample"));
});

test("a non-positive or non-finite baseline throws instead of suppressing", () => {
  // Suppression means "we cannot support this claim yet". A zero baseline
  // means the caller is wrong, and hiding it behind the same banner as an
  // honest small sample would let a bug read as patience.
  for (const medianActiveMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => describeReviewTimeReduction(assisted(300_000, 20), { source: "measured_preassist", medianActiveMs }, 10),
      /positive baseline medianActiveMs/
    );
  }
});

test("applications whose only visit was idle-truncated show up as an incomplete population", () => {
  // AF-54 drops truncated spans, so such an application never reaches the
  // denominator. The risk is that it also quietly leaves the population and
  // the sample looks complete.
  const spans: readonly ReviewTimingSpan[] = [
    { applicationId: "a", activeMs: 300_000, truncatedByIdle: false },
    { applicationId: "b", activeMs: 300_000, truncatedByIdle: false },
    { applicationId: "c", activeMs: 999_999, truncatedByIdle: true }
  ];
  const timing = summarizeReviewTiming(spans, 3);
  assert.equal(timing.sampleSize, 2);
  const sample = describeReviewTimeReduction(timing, MEASURED, 2);
  assert.equal(sample.value, 0.5);
  assert.ok(codes(sample).includes("population_incomplete"));
});

test("end to end from spans: time is summed per application before the median", () => {
  // Three twenty-second visits to one candidate is a minute of review, not
  // twenty seconds. Getting this backwards understates the assisted side
  // and overstates the reduction.
  const spans: readonly ReviewTimingSpan[] = [
    { applicationId: "a", activeMs: 100_000, truncatedByIdle: false },
    { applicationId: "a", activeMs: 100_000, truncatedByIdle: false },
    { applicationId: "a", activeMs: 100_000, truncatedByIdle: false }
  ];
  const sample = describeReviewTimeReduction(summarizeReviewTiming(spans, 1), MEASURED, 1);
  assert.equal(sample.value, 0.5, "300000ms against a 600000ms baseline");
});

test("the reported sample size is the number of applications, not the number of spans", () => {
  const spans: readonly ReviewTimingSpan[] = [
    { applicationId: "a", activeMs: 150_000, truncatedByIdle: false },
    { applicationId: "a", activeMs: 150_000, truncatedByIdle: false },
    { applicationId: "b", activeMs: 300_000, truncatedByIdle: false }
  ];
  const sample = describeReviewTimeReduction(summarizeReviewTiming(spans, 2), MEASURED, 2);
  assert.equal(sample.sampleSize, 2, "three spans over two applications is a sample of two");
  assert.equal(sample.population, 2);
});
