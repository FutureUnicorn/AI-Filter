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

// AF-41 review (#24), codex P2. Every comparison in checkInferenceBudget is
// false against NaN, so a malformed numeric environment value fell through to
// "ok" and silently disabled the cap: the one outcome a budget check must
// never reach by accident.

test("a NaN cap is refused, not treated as no cap at all", () => {
  assert.throws(
    () => checkInferenceBudget({ tokensUsedThisPeriod: 5000 }, { maxTokensPerPeriod: NaN, alertThresholdRatio: 0.8 }),
    /non-negative safe integer maxTokensPerPeriod/
  );
});

test("an infinite cap is refused", () => {
  assert.throws(
    () =>
      checkInferenceBudget(
        { tokensUsedThisPeriod: 5000 },
        { maxTokensPerPeriod: Number.POSITIVE_INFINITY, alertThresholdRatio: 0.8 }
      ),
    /non-negative safe integer maxTokensPerPeriod/
  );
});

test("a negative cap is refused rather than capping everything", () => {
  assert.throws(
    () => checkInferenceBudget({ tokensUsedThisPeriod: 0 }, { maxTokensPerPeriod: -1, alertThresholdRatio: 0.8 }),
    /non-negative safe integer maxTokensPerPeriod/
  );
});

test("a NaN alert ratio is refused, so warning cannot silently never fire", () => {
  assert.throws(
    () => checkInferenceBudget({ tokensUsedThisPeriod: 900 }, { maxTokensPerPeriod: 1000, alertThresholdRatio: NaN }),
    /alertThresholdRatio between 0 and 1/
  );
});

test("an alert ratio above one is refused", () => {
  assert.throws(
    () => checkInferenceBudget({ tokensUsedThisPeriod: 900 }, { maxTokensPerPeriod: 1000, alertThresholdRatio: 1.5 }),
    /alertThresholdRatio between 0 and 1/
  );
});

test("NaN usage is refused rather than reading as under the cap", () => {
  assert.throws(
    () => checkInferenceBudget({ tokensUsedThisPeriod: NaN }, config),
    /non-negative tokensUsedThisPeriod/
  );
});

test("zero usage against a zero cap is still capped, and a zero ratio is legal", () => {
  // Pins the boundary the database path was contradicting: at the cap is
  // capped, even when the cap is zero and nothing has been spent.
  const result = checkInferenceBudget({ tokensUsedThisPeriod: 0 }, { maxTokensPerPeriod: 0, alertThresholdRatio: 0 });
  assert.deepEqual(result, { outcome: "capped", tokensUsedThisPeriod: 0, maxTokensPerPeriod: 0 });
});
