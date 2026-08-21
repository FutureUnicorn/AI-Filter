import assert from "node:assert/strict";
import test from "node:test";

import { checkInferenceKillSwitch } from "../../packages/domain/src/index.ts";

test("disengaged allows the call", () => {
  const result = checkInferenceKillSwitch({ engaged: false });
  assert.deepEqual(result, { allowed: true });
});

test("engaged blocks the call and carries the operator's reason", () => {
  const result = checkInferenceKillSwitch({ engaged: true, reason: "Provider incident" });
  assert.deepEqual(result, { allowed: false, reason: "Provider incident" });
});

test("engaged with no reason still blocks, with a sensible default message", () => {
  const result = checkInferenceKillSwitch({ engaged: true });
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.ok(result.reason.length > 0);
  }
});

test("disengaged with a leftover reason string still allows the call", () => {
  // A disengage that clears reason server-side is the DB's job (AF-42's
  // migration); this pure function only looks at `engaged`.
  const result = checkInferenceKillSwitch({ engaged: false, reason: "stale text" });
  assert.equal(result.allowed, true);
});
