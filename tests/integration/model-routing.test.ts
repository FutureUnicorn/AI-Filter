import assert from "node:assert/strict";
import test from "node:test";

import { ESCALATION_SIGNAL_REASONS, routeModel } from "../../packages/ai/src/index.ts";

const config = { defaultModel: "gpt-5.6", escalationModel: "gpt-5.6-pro" };
const noSignals = {
  unreadableInput: false,
  citationFailed: false,
  contradictionDetected: false,
  injectionIndicatorDetected: false
};

test("with no observable quality flags, routing stays on the default model", () => {
  const result = routeModel(config, noSignals);
  assert.deepEqual(result, { model: "gpt-5.6", tier: "default", reasons: [] });
});

test("an unreadable input escalates with the matching reason", () => {
  const result = routeModel(config, { ...noSignals, unreadableInput: true });
  assert.equal(result.model, "gpt-5.6-pro");
  assert.equal(result.tier, "escalated");
  assert.deepEqual(result.reasons, ["unreadable_input"]);
});

test("a failed citation escalates with the matching reason", () => {
  const result = routeModel(config, { ...noSignals, citationFailed: true });
  assert.equal(result.model, "gpt-5.6-pro");
  assert.equal(result.tier, "escalated");
  assert.deepEqual(result.reasons, ["citation_failed"]);
});

test("a detected contradiction escalates with the matching reason", () => {
  const result = routeModel(config, { ...noSignals, contradictionDetected: true });
  assert.equal(result.model, "gpt-5.6-pro");
  assert.equal(result.tier, "escalated");
  assert.deepEqual(result.reasons, ["contradiction_detected"]);
});

test("an injection indicator escalates with the matching reason", () => {
  const result = routeModel(config, { ...noSignals, injectionIndicatorDetected: true });
  assert.equal(result.model, "gpt-5.6-pro");
  assert.equal(result.tier, "escalated");
  assert.deepEqual(result.reasons, ["injection_indicator_detected"]);
});

// Asserting `reasons` alone leaves the escalation itself unchecked: a
// routeModel that returned the DEFAULT model while still listing a reason
// would satisfy a reasons-only assertion, which is the one failure the
// whole function exists to prevent. Driven off the table so a newly added
// signal is covered the moment it is added, rather than when someone
// remembers to write the case.
test("every signal on its own escalates the model and the tier, not just the reason list", () => {
  for (const [signal, reason] of ESCALATION_SIGNAL_REASONS) {
    const result = routeModel(config, { ...noSignals, [signal]: true });
    assert.equal(result.model, "gpt-5.6-pro", `${signal} did not escalate the model`);
    assert.equal(result.tier, "escalated", `${signal} did not escalate the tier`);
    assert.deepEqual(result.reasons, [reason], `${signal} reported the wrong reason`);
  }
});

// The naming rule, asserted rather than trusted. injection_indicator
// silently dropped its `_detected` suffix while the other three kept the
// snake_case of their signal; each line read fine alone, so only a check
// that compares them as a set catches it.
test("every escalation reason is the snake_case of the signal that raises it", () => {
  const snakeCase = (name: string) => name.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`);
  for (const [signal, reason] of ESCALATION_SIGNAL_REASONS) {
    assert.equal(reason, snakeCase(signal), `${signal} and ${reason} do not correspond`);
  }
  assert.equal(
    new Set(ESCALATION_SIGNAL_REASONS.map(([, reason]) => reason)).size,
    ESCALATION_SIGNAL_REASONS.length,
    "two signals share a reason, so a reason cannot identify what raised it"
  );
});

test("multiple simultaneous flags all appear in reasons, and still route to the escalation model once", () => {
  const result = routeModel(config, {
    unreadableInput: false,
    citationFailed: true,
    contradictionDetected: true,
    injectionIndicatorDetected: false
  });
  assert.equal(result.model, "gpt-5.6-pro");
  assert.equal(result.tier, "escalated");
  assert.deepEqual(result.reasons, ["citation_failed", "contradiction_detected"]);
});

test("routing is a pure function of its inputs: same signals always produce the same result", () => {
  const first = routeModel(config, { ...noSignals, contradictionDetected: true });
  const second = routeModel(config, { ...noSignals, contradictionDetected: true });
  assert.deepEqual(first, second);
});
