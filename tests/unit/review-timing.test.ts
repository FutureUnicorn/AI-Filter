import assert from "node:assert/strict";
import test from "node:test";

import { summarizeReviewTiming } from "../../packages/domain/src/index.ts";
import type { ReviewTimingSpan } from "../../packages/domain/src/index.ts";

// AF-54: "Time-per-application in the review queue, needed as the
// baseline for the review-time-reduction metric."

function span(applicationId: string, activeMs: number, truncatedByIdle = false): ReviewTimingSpan {
  return { applicationId, activeMs, truncatedByIdle };
}

test("visits to the same application are summed, not treated as separate reviews", () => {
  // A candidate opened three times for twenty seconds each took a
  // minute, not twenty seconds. A median over raw spans reports the
  // latter and understates the baseline -- which makes any later
  // improvement look larger than it was.
  const summary = summarizeReviewTiming(
    [span("app-1", 20_000), span("app-1", 20_000), span("app-1", 20_000)],
    1
  );
  assert.equal(summary.medianActiveMs, 60_000);
  assert.equal(summary.sampleSize, 1, "three visits to one candidate is one measurement");
});

test("the median is taken across applications, and is a median rather than a mean", () => {
  // 1s, 2s, 3s, 4s, 300s. Mean is 62s; median is 3s. A mean is dragged
  // by a lunch break with the tab open.
  const summary = summarizeReviewTiming(
    [span("a", 1_000), span("b", 2_000), span("c", 3_000), span("d", 4_000), span("e", 300_000)],
    5
  );
  assert.equal(summary.medianActiveMs, 3_000);
});

test("an even sample averages the two middle applications", () => {
  const summary = summarizeReviewTiming([span("a", 1_000), span("b", 2_000), span("c", 4_000), span("d", 5_000)], 4);
  assert.equal(summary.medianActiveMs, 3_000);
});

test("idle-truncated spans are excluded from the value but counted in the open", () => {
  // A truncated span is a lower bound, not a measurement: the reviewer
  // stopped looking and we do not know when. Including it biases the
  // baseline downward, again in the direction that flatters a later
  // improvement. Dropping it silently would hide how much data went.
  const summary = summarizeReviewTiming(
    [span("a", 60_000), span("b", 5_000, true), span("c", 40_000)],
    3
  );
  assert.equal(summary.sampleSize, 2, "the truncated application contributes no measurement");
  assert.equal(summary.medianActiveMs, 50_000);
  assert.equal(summary.truncatedSpanCount, 1, "and the reader is told one span was dropped");
});

test("an application whose only spans were truncated does not reach the denominator", () => {
  const summary = summarizeReviewTiming([span("a", 5_000, true), span("a", 6_000, true)], 1);
  assert.equal(summary.sampleSize, 0);
  assert.equal(summary.medianActiveMs, null);
  assert.equal(summary.truncatedSpanCount, 2);
});

test("an application with one usable span and one truncated span leaves the denominator entirely", () => {
  // The whole application goes, not just the truncated span. Keeping it
  // records a candidate who was reviewed for AT LEAST eleven minutes as
  // an eleven-minute review, and every such application drags the median
  // down. Downward here means the reduction computed against it comes
  // out larger than the evidence supports.
  const summary = summarizeReviewTiming(
    [span("a", 660_000), span("a", 400_000, true), span("b", 900_000), span("c", 1_200_000)],
    3
  );
  assert.equal(summary.sampleSize, 2, "only b and c are fully observed");
  assert.equal(summary.medianActiveMs, 1_050_000, "a must not pull the median down to 900,000");
  assert.equal(summary.partiallyObservedCount, 1, "and the reader is told an application was dropped, not just a span");
  assert.equal(summary.truncatedSpanCount, 1);
});

test("when every application is partially observed the sample is empty, not complete", () => {
  // The failure this pins: dropping the span alone left sampleSize equal
  // to population, so the result carried no limitation at all and read
  // as a complete measurement of a role nobody has fully reviewed.
  const summary = summarizeReviewTiming(
    [
      span("a", 300_000),
      span("a", 400_000, true),
      span("b", 300_000),
      span("b", 400_000, true),
      span("c", 300_000),
      span("c", 400_000, true)
    ],
    3
  );
  assert.equal(summary.sampleSize, 0);
  assert.equal(summary.medianActiveMs, null);
  assert.equal(summary.partiallyObservedCount, 3);
});

test("no measurements reports null, never zero", () => {
  // Zero would read as "reviews take no time", and a zero is exactly the
  // kind of number that gets quoted without its context.
  const summary = summarizeReviewTiming([], 12);
  assert.equal(summary.medianActiveMs, null);
  assert.equal(summary.sampleSize, 0);
  assert.equal(summary.population, 12, "the population is still reported, so the gap is visible");
});

test("population is carried through untouched, so the denominator and the scope stay distinct", () => {
  // 2 measured out of 50 in scope is a very different claim from 2 out
  // of 2, and only reporting both makes them distinguishable.
  const summary = summarizeReviewTiming([span("a", 1_000), span("b", 3_000)], 50);
  assert.equal(summary.sampleSize, 2);
  assert.equal(summary.population, 50);
});

test("the summary carries no per-reviewer field at all", () => {
  // Time-per-application is a product baseline. The same numbers grouped
  // by person are a performance-management dataset, and this shape must
  // not be one visit away from becoming that.
  const summary = summarizeReviewTiming([span("a", 1_000)], 1);
  assert.deepEqual(
    Object.keys(summary).sort(),
    ["medianActiveMs", "partiallyObservedCount", "population", "sampleSize", "truncatedSpanCount"]
  );
});

test("span order does not change the answer", () => {
  const spans = [span("a", 3_000), span("b", 1_000), span("a", 2_000), span("c", 9_000)];
  const forward = summarizeReviewTiming(spans, 3);
  const reversed = summarizeReviewTiming([...spans].reverse(), 3);
  assert.deepEqual(forward, reversed);
});

test("a single measured application is its own median", () => {
  assert.equal(summarizeReviewTiming([span("a", 7_500)], 4).medianActiveMs, 7_500);
});

// AF-55 REV-001. AF-54 now refuses a zero-duration span at the contract and
// at the database, but rows written before those constraints existed remain
// readable, and this summary is what decides whether an application counts
// as measured. A zero here does two things at once: it drags the assisted
// median down, inflating the reported review-time reduction, and it inflates
// sampleSize, which is the number AF-60 uses to say whether the figure can
// be trusted at all. So the exclusion lives here too, not only upstream.

test("a zero-duration span cannot make an application count as measured", () => {
  const base = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    reviewerUserId: "22222222-2222-4222-8222-222222222222",
    truncatedByIdle: false
  };
  const summary = summarizeReviewTiming([
    { ...base, applicationId: "a", activeMs: 60_000 },
    { ...base, applicationId: "b", activeMs: 0 }
  ]);
  assert.equal(summary.sampleSize, 1, "the zero-time application must not be counted");
  assert.equal(summary.medianActiveMs, 60_000, "and must not move the median");
});

test("an application with only zero-duration spans contributes nothing at all", () => {
  const base = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    reviewerUserId: "22222222-2222-4222-8222-222222222222",
    truncatedByIdle: false
  };
  const summary = summarizeReviewTiming([
    { ...base, applicationId: "only-zero", activeMs: 0 },
    { ...base, applicationId: "only-zero", activeMs: 0 }
  ]);
  assert.equal(summary.sampleSize, 0, "no measured time means no sample");
  assert.equal(summary.medianActiveMs, null, "and no median to report");
});
