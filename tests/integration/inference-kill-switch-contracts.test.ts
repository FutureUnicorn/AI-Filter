import assert from "node:assert/strict";
import test from "node:test";

import { assertKillSwitchTransitionLog } from "../../packages/db/src/index.ts";

// AF-42 review (#25). Both findings here live in the database's three-valued
// logic and its overwrite semantics, so neither can be reproduced in
// TypeScript: they need a real Postgres to mean anything.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

function requireDatabase(): string {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set. See README.md.");
  }
  return DATABASE_URL;
}

test("engaging with no reason at all is refused by the table", async () => {
  const observed = await assertKillSwitchTransitionLog(requireDatabase());
  assert.equal(observed.nullReasonRejected, true);

  // The failure mode being prevented, shown rather than described.
  // `reason ~ '[^[:space:]]'` against NULL is NULL, not false, so the whole
  // CHECK evaluated to NULL and Postgres accepts true OR NULL. The switch
  // could be engaged with no reason, undoing the invariant 0008 and 0009
  // exist to establish.
  assert.equal(
    observed.nullReasonAcceptedByOldConstraint,
    true,
    "the pre-review constraint should accept this; if it no longer does, this test has stopped proving anything"
  );
});

test("each transition's reason outlives the transition after it", async () => {
  // The singleton holds current state, so disengaging clears the reason the
  // engage recorded. Before the log existed, the trail could say the switch
  // was engaged and never say why.
  const observed = await assertKillSwitchTransitionLog(requireDatabase());
  assert.deepEqual(observed.loggedReasons, ["runaway extraction loop", null]);
  assert.equal(observed.singletonReasonAfterDisengage, null, "the singleton is overwritten, as expected");
});
