import assert from "node:assert/strict";
import test from "node:test";

import { killSwitchRetryOutcome } from "../../packages/ai/src/index.ts";

const SUBJECT = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  candidateId: "22222222-2222-4222-8222-222222222222"
};

test("a kill-switch block maps to retrying, never failed or extraction_error", () => {
  const outcome = killSwitchRetryOutcome(SUBJECT, "python_production", 2, 5);
  assert.equal(outcome.kind, "retrying");
  assert.notEqual(outcome.kind, "failed");
  assert.notEqual(outcome.kind, "extraction_error");
});

test("attempt and maxAttempts are preserved exactly, so a caller can tell how many tries remain", () => {
  const outcome = killSwitchRetryOutcome(SUBJECT, "python_production", 2, 5);
  assert.equal(outcome.kind === "retrying" ? outcome.attempt : undefined, 2);
  assert.equal(outcome.kind === "retrying" ? outcome.maxAttempts : undefined, 5);
});

test("the criterionId of the halted criterion is preserved, not lost", () => {
  const outcome = killSwitchRetryOutcome(SUBJECT, "aws_certification", 1, 3);
  assert.equal(outcome.criterionId, "aws_certification");
});

// AF-42 review (#25), codex P2. This helper promises a PERSISTABLE outcome,
// and retryingEvidenceSchema requires two positive integers with
// attempt <= maxAttempts. Accepting nonsense here and failing at the write
// means paused work breaks at the moment someone tries to save it, which is
// exactly the moment the kill switch was supposed to have made safe.

test("a zero or fractional counter is refused where the caller is", () => {
  for (const [attempt, maxAttempts] of [
    [0, 5],
    [1, 0],
    [1.5, 5],
    [1, 5.5],
    [-1, 5]
  ] as const) {
    assert.throws(
      () => killSwitchRetryOutcome(SUBJECT, "python_production", attempt, maxAttempts),
      /requires a positive integer (attempt|maxAttempts)/,
      `attempt=${attempt} maxAttempts=${maxAttempts} was accepted`
    );
  }
});

test("an already-exhausted retry is not a retrying outcome", () => {
  assert.throws(
    () => killSwitchRetryOutcome(SUBJECT, "python_production", 4, 3),
    /cannot describe attempt 4 of 3/
  );
});

test("the boundary case of a final attempt is still valid", () => {
  const outcome = killSwitchRetryOutcome(SUBJECT, "python_production", 3, 3);
  assert.equal(outcome.kind, "retrying");
});
