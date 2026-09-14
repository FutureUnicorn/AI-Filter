import assert from "node:assert/strict";
import test from "node:test";

import { assertIdempotentRequestSemantics } from "../../packages/db/src/index.ts";

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
