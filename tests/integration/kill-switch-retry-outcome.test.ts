import assert from "node:assert/strict";
import test from "node:test";

import { killSwitchRetryOutcome } from "../../packages/ai/src/index.ts";

test("a kill-switch block maps to retrying, never failed or extraction_error", () => {
  const outcome = killSwitchRetryOutcome("python_production", 2, 5);
  assert.equal(outcome.kind, "retrying");
  assert.notEqual(outcome.kind, "failed");
  assert.notEqual(outcome.kind, "extraction_error");
});

test("attempt and maxAttempts are preserved exactly, so a caller can tell how many tries remain", () => {
  const outcome = killSwitchRetryOutcome("python_production", 2, 5);
  assert.equal(outcome.kind === "retrying" ? outcome.attempt : undefined, 2);
  assert.equal(outcome.kind === "retrying" ? outcome.maxAttempts : undefined, 5);
});

test("the criterionId of the halted criterion is preserved, not lost", () => {
  const outcome = killSwitchRetryOutcome("aws_certification", 1, 3);
  assert.equal(outcome.criterionId, "aws_certification");
});
