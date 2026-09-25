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
    activeMs: 0
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
