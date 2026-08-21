import assert from "node:assert/strict";
import test from "node:test";

import { checkInferenceBudget } from "../../packages/domain/src/index.ts";

const config = { maxTokensPerPeriod: 1000, alertThresholdRatio: 0.8 };

test("well under the cap is ok", () => {
  const result = checkInferenceBudget({ tokensUsedThisPeriod: 100 }, config);
  assert.deepEqual(result, { outcome: "ok" });
});

test("at the alert threshold is a warning, not ok and not capped", () => {
  const result = checkInferenceBudget({ tokensUsedThisPeriod: 800 }, config);
  assert.deepEqual(result, { outcome: "warning", tokensUsedThisPeriod: 800, maxTokensPerPeriod: 1000 });
});

test("just under the alert threshold is still ok", () => {
  const result = checkInferenceBudget({ tokensUsedThisPeriod: 799 }, config);
  assert.equal(result.outcome, "ok");
});

test("at the cap is capped, not a warning", () => {
  const result = checkInferenceBudget({ tokensUsedThisPeriod: 1000 }, config);
  assert.deepEqual(result, { outcome: "capped", tokensUsedThisPeriod: 1000, maxTokensPerPeriod: 1000 });
});

test("over the cap is capped", () => {
  const result = checkInferenceBudget({ tokensUsedThisPeriod: 5000 }, config);
  assert.equal(result.outcome, "capped");
});

test("capped takes priority over warning at the exact boundary (never both)", () => {
  const result = checkInferenceBudget({ tokensUsedThisPeriod: 1000 }, config);
  assert.notEqual(result.outcome, "warning");
});

test("zero usage against a zero cap is capped, not a division error", () => {
  const result = checkInferenceBudget({ tokensUsedThisPeriod: 0 }, { maxTokensPerPeriod: 0, alertThresholdRatio: 0.8 });
  assert.equal(result.outcome, "capped");
});
