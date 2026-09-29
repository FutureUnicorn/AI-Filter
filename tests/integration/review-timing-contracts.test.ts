import assert from "node:assert/strict";
import test from "node:test";

import { recordReviewTimingSpanInputSchema } from "../../packages/contracts/src/index.ts";

// AF-54: what a client is allowed to say about how long a review took.
// The database holds the same two bounds as CHECK constraints; these
// exist so a miscomputed client gets a 400 with a reason instead of a
// constraint violation surfacing as a 500 that reads like a server bug.

const honest = {
  startedAt: "2026-08-29T10:00:00.000Z",
  endedAt: "2026-08-29T10:01:30.000Z",
  activeMs: 90_000,
  truncatedByIdle: false
};

test("an honest span parses", () => {
  assert.equal(recordReviewTimingSpanInputSchema.safeParse(honest).success, true);
});

test("a caller cannot name the reviewer", () => {
  // The reviewer is the session's own user. A body field naming one is
  // rejected rather than ignored, which is the difference between a
  // convention and a boundary -- and this row is a named person's
  // working rate, so filing it under someone else matters.
  const result = recordReviewTimingSpanInputSchema.safeParse({
    ...honest,
    reviewerUserId: "11111111-1111-4111-8111-111111111111"
  });
  assert.equal(result.success, false);
  assert.equal(result.error?.issues.some((issue) => issue.code === "unrecognized_keys"), true);
});

test("active time cannot exceed the wall clock it sits inside", () => {
  // The fabricated-duration case. Eight hours of activity inside ninety
  // seconds is the shape that would quietly corrupt the baseline.
  const result = recordReviewTimingSpanInputSchema.safeParse({ ...honest, activeMs: 28_800_000 });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues.at(0)?.path, ["activeMs"]);
});

test("a span cannot end before it started", () => {
  const result = recordReviewTimingSpanInputSchema.safeParse({
    ...honest,
    startedAt: "2026-08-29T10:01:30.000Z",
    endedAt: "2026-08-29T10:00:00.000Z",
    // One millisecond, not zero. activeMs must now be positive, so a zero
    // here would be refused for that instead and this case would stop
    // testing the ordering rule it was written for.
    activeMs: 1
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues.at(0)?.path, ["endedAt"]);
});

test("negative and fractional active time are both rejected", () => {
  assert.equal(recordReviewTimingSpanInputSchema.safeParse({ ...honest, activeMs: -1 }).success, false);
  // active_ms is an integer column; a float would round on the way in
  // and the stored value would not be the one that was validated.
  assert.equal(recordReviewTimingSpanInputSchema.safeParse({ ...honest, activeMs: 1.5 }).success, false);
});

test("truncatedByIdle is required, because a missing flag is not the same as false", () => {
  const withoutFlag: Record<string, unknown> = { ...honest };
  delete withoutFlag.truncatedByIdle;
  assert.equal(recordReviewTimingSpanInputSchema.safeParse(withoutFlag).success, false);
  assert.equal(recordReviewTimingSpanInputSchema.safeParse({ ...honest, truncatedByIdle: true }).success, true);
});

test("the one-second tolerance matches the database, and stops there", () => {
  // Migration 0021 allows a second of slack for clock granularity at the
  // edges. The two layers agreeing on the boundary is the point: a value
  // this accepts and Postgres rejects would be a 500.
  const wallClockMs = 90_000;
  assert.equal(
    recordReviewTimingSpanInputSchema.safeParse({ ...honest, activeMs: wallClockMs + 1_000 }).success,
    true
  );
  assert.equal(
    recordReviewTimingSpanInputSchema.safeParse({ ...honest, activeMs: wallClockMs + 1_001 }).success,
    false
  );
});

// A zero-duration span is not a measurement. sealReviewTiming already
// refuses to emit one, but the contract accepted it, so a direct
// authenticated POST could put an application into the measured sample
// with no measured time: the assisted median falls, the reported
// review-time reduction rises, and the sample looks larger for it. The
// database carries the matching CHECK; this is the boundary that turns it
// into a 400 with a reason rather than a constraint violation read as a
// server fault.

test("a zero-duration span is refused before it can reach the sample", () => {
  const parsed = recordReviewTimingSpanInputSchema.safeParse({ ...honest, activeMs: 0 });
  assert.equal(parsed.success, false, "activeMs: 0 must not be accepted");
  if (!parsed.success) {
    assert.match(
      JSON.stringify(parsed.error.issues),
      /activeMs/u,
      "the refusal must name the field so a client can act on it"
    );
  }
});

test("a negative span is refused too, and one millisecond is still a measurement", () => {
  assert.equal(recordReviewTimingSpanInputSchema.safeParse({ ...honest, activeMs: -1 }).success, false);
  // The boundary is positive, not "large enough". A real one-millisecond
  // review is implausible but it is a measurement, and the contract has no
  // business inventing a minimum the product never agreed.
  assert.equal(recordReviewTimingSpanInputSchema.safeParse({ ...honest, activeMs: 1 }).success, true);
});
