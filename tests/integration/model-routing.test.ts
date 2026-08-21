import assert from "node:assert/strict";
import test from "node:test";

import { routeModel } from "../../packages/ai/src/index.ts";

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
  assert.deepEqual(result.reasons, ["citation_failed"]);
});

test("a detected contradiction escalates with the matching reason", () => {
  const result = routeModel(config, { ...noSignals, contradictionDetected: true });
  assert.deepEqual(result.reasons, ["contradiction_detected"]);
});

test("an injection indicator escalates with the matching reason", () => {
  const result = routeModel(config, { ...noSignals, injectionIndicatorDetected: true });
  assert.deepEqual(result.reasons, ["injection_indicator"]);
});

test("multiple simultaneous flags all appear in reasons, and still route to the escalation model once", () => {
  const result = routeModel(config, {
    unreadableInput: false,
    citationFailed: true,
    contradictionDetected: true,
    injectionIndicatorDetected: false
  });
  assert.equal(result.model, "gpt-5.6-pro");
  assert.deepEqual(result.reasons, ["citation_failed", "contradiction_detected"]);
});

test("routing is a pure function of its inputs: same signals always produce the same result", () => {
  const first = routeModel(config, { ...noSignals, contradictionDetected: true });
  const second = routeModel(config, { ...noSignals, contradictionDetected: true });
  assert.deepEqual(first, second);
});
