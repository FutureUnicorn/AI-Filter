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
