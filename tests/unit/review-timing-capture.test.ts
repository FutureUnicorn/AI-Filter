import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_IDLE_CUTOFF_MS,
  beginReviewTiming,
  recordReviewActivity,
  sealReviewTiming,
  settleReviewTiming,
  summarizeReviewTiming
} from "../../packages/domain/src/index.ts";
import type { ReviewTimingState } from "../../packages/domain/src/index.ts";

// AF-54, the half that produces the spans tests/unit/review-timing.ts
// summarizes. Clock-free on purpose: every instant is passed in, so the
// idle rules can be tested exactly rather than waited for.

const START = 1_700_000_000_000;

function activity(state: ReviewTimingState, atMs: number): ReviewTimingState {
  return recordReviewActivity(state, atMs).state;
}

test("a visit measures the time the page was actually open", () => {
  const state = activity(beginReviewTiming(START), START + 30_000);
  const span = sealReviewTiming(state, START + 45_000);
  assert.equal(span?.activeMs, 45_000);
  assert.equal(span?.truncatedByIdle, false);
  assert.equal(span?.startedAtMs, START);
  assert.equal(span?.endedAtMs, START + 45_000);
});

test("going idle stops the clock at the last interaction, not at the cutoff", () => {
  // The grace window is how long we wait before concluding the reviewer
  // left; it is not review. Counting it would add up to two minutes of
  // absence to every abandoned span and make "truncated spans are a
  // lower bound" false -- which is the claim that justifies excluding
  // them from the median rather than investigating them.
  const state = activity(beginReviewTiming(START), START + 10_000);
  const span = sealReviewTiming(state, START + 10_000 + REVIEW_IDLE_CUTOFF_MS + 5_000);
  assert.equal(span?.truncatedByIdle, true);
  assert.equal(span?.activeMs, 10_000, "only the proven ten seconds count");
  assert.equal(span?.endedAtMs, START + 10_000);
});

test("a tab left open overnight records the review, not the night", () => {
  // The failure mode migration 0021 names. Thirty seconds of review and
  // eight hours of an abandoned tab must not become eight hours of it.
  const state = activity(beginReviewTiming(START), START + 30_000);
  const span = sealReviewTiming(state, START + 8 * 60 * 60 * 1_000);
  assert.equal(span?.activeMs, 30_000);
  assert.equal(span?.endedAtMs - span?.startedAtMs, 30_000);
});

test("the cutoff boundary itself is still reviewing", () => {
  const state = activity(beginReviewTiming(START), START + 1_000);
  const atBoundary = sealReviewTiming(state, START + 1_000 + REVIEW_IDLE_CUTOFF_MS);
  assert.equal(atBoundary?.truncatedByIdle, false);
  const pastBoundary = sealReviewTiming(state, START + 1_000 + REVIEW_IDLE_CUTOFF_MS + 1);
  assert.equal(pastBoundary?.truncatedByIdle, true);
});

test("the cutoff moves active time, it does not only set a flag", () => {
  // Where the cliff is, pinned. One millisecond either side of the
  // cutoff swings activeMs by the whole width of the grace window,
  // because below it we believe the reviewer was reading silently and
  // above it we stop believing. That is what a threshold means rather
  // than an artefact, but it is worth a test, because it makes the cost
  // of moving the constant concrete: lengthening the cutoff does not
  // merely flag fewer spans, it lets more provably idle time count as
  // review inside the spans that stay unflagged, and that inflates the
  // very baseline this ticket exists to produce.
  const state = activity(beginReviewTiming(START), START + 10_000);
  const justInside = sealReviewTiming(state, START + 10_000 + REVIEW_IDLE_CUTOFF_MS);
  const justOutside = sealReviewTiming(state, START + 10_000 + REVIEW_IDLE_CUTOFF_MS + 1);

  assert.equal(justInside?.activeMs, 10_000 + REVIEW_IDLE_CUTOFF_MS);
  assert.equal(justInside?.truncatedByIdle, false);
  assert.equal(justOutside?.activeMs, 10_000, "past the cutoff, only the proven interaction counts");
  assert.equal(justOutside?.truncatedByIdle, true);
});

test("coming back after the cutoff ends the old span and opens a new one", () => {
  // Not a resumption: the gap is not review. Handing the finished span
  // back is also what stops the other failure -- a span that truncated
  // once and then quietly measures nothing for the rest of the visit.
  const state = activity(beginReviewTiming(START), START + 20_000);
  const returnAt = START + 20_000 + REVIEW_IDLE_CUTOFF_MS + 600_000;
  const transition = recordReviewActivity(state, returnAt);

  assert.equal(transition.completed?.activeMs, 20_000);
  assert.equal(transition.completed?.truncatedByIdle, true);
  assert.equal(transition.state.startedAtMs, returnAt, "the new span starts where the reviewer came back");
  assert.equal(transition.state.truncatedByIdle, false);

  const second = sealReviewTiming(activity(transition.state, returnAt + 5_000), returnAt + 5_000);
  assert.equal(second?.activeMs, 5_000, "the ten minutes away are in neither span");
});

test("a span that measured nothing is not sent at all", () => {
  // Opened and immediately closed. Recording it would put the
  // application into summarizeReviewTiming's denominator carrying a
  // total of zero and pull the median toward "reviews take no time".
  assert.equal(sealReviewTiming(beginReviewTiming(START), START), undefined);
});

test("a span can never claim more active time than the wall clock it sits inside", () => {
  // The bound migration 0021 enforces as a CHECK. Asserted here across
  // every shape this producer can reach, so a violation is caught before
  // it reaches a constraint violation that reads like a server fault.
  const paths: ReviewTimingState[] = [
    beginReviewTiming(START),
    activity(beginReviewTiming(START), START + 1),
    activity(activity(beginReviewTiming(START), START + 5_000), START + 90_000),
    settleReviewTiming(activity(beginReviewTiming(START), START + 5_000), START + 10_000_000)
  ];
  for (const state of paths) {
    for (const atMs of [START, START + 1_000, START + 10_000_000]) {
      const span = sealReviewTiming(state, atMs);
      if (span === undefined) {
        continue;
      }
      assert.ok(span.activeMs >= 0, "active time is never negative");
      assert.ok(
        span.activeMs <= span.endedAtMs - span.startedAtMs,
        `active ${span.activeMs} exceeds the wall clock ${span.endedAtMs - span.startedAtMs}`
      );
    }
  }
});

test("a clock that jumps backwards does not un-count time already counted", () => {
  // Date.now() is not monotonic: an NTP correction mid-review would
  // otherwise produce a negative active_ms and a rejected insert.
  const state = settleReviewTiming(activity(beginReviewTiming(START), START + 30_000), START + 60_000);
  const span = sealReviewTiming(state, START - 500_000);
  assert.equal(span?.activeMs, 60_000);
});

test("settling repeatedly at the same instant counts that instant once", () => {
  const once = settleReviewTiming(beginReviewTiming(START), START + 10_000);
  const twice = settleReviewTiming(settleReviewTiming(once, START + 10_000), START + 10_000);
  assert.deepEqual(twice, once);
});

test("the drafts this produces are exactly what the summary consumes", () => {
  // The two halves of AF-54 meeting. One application, two visits of
  // twenty seconds each, and the baseline says forty -- which is the
  // sum-then-median rule in review-timing.test.ts seen from the
  // producing end.
  const first = sealReviewTiming(activity(beginReviewTiming(START), START + 20_000), START + 20_000);
  const later = START + 3_600_000;
  const second = sealReviewTiming(activity(beginReviewTiming(later), later + 20_000), later + 20_000);
  assert.ok(first !== undefined && second !== undefined);

  const summary = summarizeReviewTiming(
    [first, second].map((draft) => ({
      applicationId: "app-1",
      activeMs: draft.activeMs,
      truncatedByIdle: draft.truncatedByIdle
    })),
    1
  );
  assert.equal(summary.medianActiveMs, 40_000);
  assert.equal(summary.sampleSize, 1);
});
