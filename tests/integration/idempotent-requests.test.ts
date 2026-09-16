import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIdempotencyIsAtomicWithTheAction,
  assertIdempotentRequestSemantics
} from "../../packages/db/src/index.ts";

/**
 * PR #83 review, P2: the decision and evidence-correction POSTs required an
 * `Idempotency-Key` by contract but neither persisted nor replayed one.
 *
 * Why this is not ordinary duplicate-delivery handling: both endpoints append
 * to a human audit trail. A retry after a lost 201 recorded a *second*
 * decision superseding the first, or a second correction superseding the
 * first correction, and the supersede chain then presents the fabricated one
 * as current. The duplicate is not a redundant copy; it is a decision or a
 * correction no person made.
 *
 * AF-32 already solved this shape for CSV finalization, but scoped to a
 * single intake row. Decisions and corrections have no such owning row, so
 * the record is keyed by endpoint in its own table.
 */
function requireDatabase(): string {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set so idempotency is exercised against real Postgres");
  }
  return databaseUrl;
}

test("the same key with the same payload replays instead of re-running", async () => {
  const observed = await assertIdempotentRequestSemantics(requireDatabase());

  // First call owns the operation.
  assert.equal(observed.firstClaim, "claimed");

  // A retry after the response was recorded replays it verbatim. Returning a
  // fresh 201 here would be indistinguishable from having recorded a second
  // decision, which is the actual defect.
  assert.equal(observed.retryClaim, "replay");
  assert.equal(observed.retryStatus, 201);
  assert.deepEqual(observed.retryBody, { decisionId: "d1" });

  // Same key, different payload is a client bug and must be refused rather
  // than silently answered with the earlier request's result.
  assert.equal(observed.mismatchClaim, "fingerprint_mismatch");

  // A claim whose operation has not finished is distinguishable from one that
  // has, so a concurrent duplicate gets a conflict rather than a bogus replay
  // of an absent response.
  assert.equal(observed.inFlightClaim, "in_flight");

  // Exactly one record exists for the key: the retry did not create a second.
  assert.equal(observed.recordCount, 1);

  // A different organization using the same key string is unaffected, so one
  // tenant can neither consume nor probe another's keys.
  assert.equal(observed.otherTenantClaim, "claimed");

  // Releasing a failed claim lets the client retry the same key rather than
  // being locked out permanently by a transient fault.
  assert.equal(observed.claimAfterRelease, "claimed");

  // A client generating one key per user action may legitimately send the
  // same value to two endpoints. Keying on the endpoint is what stops one
  // endpoint replaying the other's response.
  assert.equal(observed.sameKeyOtherEndpoint, "claimed");
});

/**
 * PR #83 review round 2, P1: the protocol above was correct in isolation and
 * not atomic with the thing it protected.
 *
 * Claim, action and completion were three calls on three connections. The
 * action committed in the middle one, so a fault before the third left the key
 * at response_status = NULL permanently: every same-key retry answered
 * in_flight, and a client that rotated to a fresh key recorded a second human
 * decision. Releasing on the error path only covered faults the process lived
 * to observe, which is precisely not the case that mattered.
 *
 * The probe injects the fault with an AFTER INSERT trigger, inside the
 * writer's own transaction, at the point the old shape had already committed.
 */
test("a fault in the idempotency window leaves nothing behind and the retry replays", async () => {
  const observed = await assertIdempotencyIsAtomicWithTheAction(requireDatabase());

  // The fault really fired; without this the rest would pass vacuously on a
  // run where the trigger silently failed to install.
  assert.equal(observed.faultedThrew, true, "the injected fault must reach the caller");

  // Nothing survives it. The decision and the claim are in one transaction, so
  // a fault discards both. Under the old shape the decision count here was 1
  // and the claim count was 1, with response_status stuck at NULL.
  assert.equal(observed.decisionsAfterFault, 0, "a faulted attempt must not leave a decision behind");
  assert.equal(observed.claimRowsAfterFault, 0, "a faulted attempt must not leave a claim behind");

  // So the same key is usable again rather than wedged, and it records once.
  assert.equal(observed.retryAfterFaultOutcome, "recorded");
  assert.equal(observed.decisionsAfterRetry, 1, "the retry must record exactly one decision");
  assert.equal(observed.claimStatusAfterRetry, 201, "the completed response must be stored with the decision");

  // And a further retry, the client having lost the 201 in transit, replays
  // the stored response verbatim instead of recording a second decision.
  assert.equal(observed.replayOutcome, "replayed");
  assert.equal(observed.replayStatus, 201);
  assert.equal(observed.replayBodyMatches, true, "the replay must return the original body, not a fresh one");
  assert.equal(observed.decisionsAfterReplay, 1, "a replay must not record a second decision");

  // The distinction the fault above cannot make on its own. A deferred
  // constraint trigger fires at COMMIT, after every statement and before the
  // commit lands, so it sees precisely what the transaction is about to make
  // durable. 201 means the completion is inside the transaction. NULL is the
  // window: it means the response is stored in a later, separate one, which
  // is the shape a crash can interrupt.
  assert.equal(
    observed.completionStatusAtCommit,
    201,
    "the idempotency response must already be written when the action's transaction commits"
  );

  // Negative control. The old three-call shape, run against the same database
  // in the same probe, still exhibits both halves of the defect: the action
  // committed alone, and the key is now permanently in_flight.
  assert.equal(observed.legacyDecisionsAfterFault, 1, "the legacy shape commits the action without its response");
  assert.equal(observed.legacySameKeyRetry, "in_flight", "the legacy shape wedges the key after a fault");

  // Which is what drives a client to rotate the key and duplicate a human
  // decision. If this ever drops to 1, the control has stopped controlling and
  // the assertions above no longer prove the fix does anything.
  assert.equal(
    observed.legacyDecisionsAfterNewKeyRetry,
    2,
    "the legacy shape duplicates the decision once the client rotates the key"
  );
});
