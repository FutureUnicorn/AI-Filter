import assert from "node:assert/strict";
import test from "node:test";

import { assertSupportAccessBoundary } from "../../packages/db/src/index.ts";

// AF-66, PR #72 REV-001. `authorizeSupportAccess` and
// `support_access_events` were both correct and neither was reachable
// from production: the decision had no caller and the table had no
// writer, so the AF-66 guarantee rested on every future support-facing
// read remembering to authorize, log and read in that order.
//
// readTenantDataUnderSupportAccess is that order, made the only way in.
// These cases are the reasons it cannot be shortened.

test("a support-facing read is authorized, logged and only then served", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises the support-access boundary against real Postgres"
    );
  }
  const observed = await assertSupportAccessBoundary(databaseUrl);

  // An operator with no grant reads nothing, and leaves no trace
  // claiming they did.
  assert.equal(observed.no_grant, "no_grant");
  assert.equal(observed.no_grant_events, "0");

  // A live grant serves the data and writes exactly one event, tied to
  // the grant that authorised it and naming what was opened.
  assert.equal(observed.allowed, "ALLOWED:Acme");
  assert.equal(observed.allowed_events, "1");
  assert.equal(observed.allowed_event_matches_grant, "true");
  assert.equal(observed.allowed_event_entity, "organization:true");

  // The handle is a read. Postgres refuses the write itself rather than
  // this code matching SQL text, which is the standard #90 REV-001
  // settled on, and the refused attempt leaves no event behind.
  assert.match(observed.read_cannot_write ?? "", /read-only transaction/);
  assert.equal(observed.read_cannot_write_events_unchanged, "true");

  // An access that cannot be logged does not happen. The event insert
  // is refused, the caller's read never runs at all, and no row is
  // left behind.
  assert.equal(observed.unloggable_refused, "REFUSED");
  assert.equal(observed.unloggable_read_never_ran, "true");
  assert.equal(observed.unloggable_events_unchanged, "true");

  // A revoked grant denies for its own reason rather than a shared one,
  // because "why was I denied" is a question asked at 3am.
  assert.equal(observed.revoked, "grant_revoked");

  // Asking for another tenant, or as another operator, finds nothing to
  // authorise rather than finding a grant and rejecting it. The lookup
  // is scoped to both in SQL on purpose: a broader one could select
  // another tenant's grant ahead of a valid one when an operator holds
  // several, and deny an access that should have succeeded. The domain
  // function keeps its own checks for callers that hand it a grant they
  // fetched themselves, and tests/unit covers those.
  assert.equal(observed.wrong_tenant, "no_grant");
  assert.equal(observed.wrong_operator, "no_grant");

  // A revocation that arrives while a read is in flight waits for that
  // read to commit rather than landing inside it. Without FOR SHARE on
  // the grant, the revoke would complete mid-read and the operator
  // would be served data under an authority that no longer existed.
  // "pending" and not "fulfilled": the UPDATE had been issued on an
  // already-open connection and had still not landed. A rejection would
  // report itself here rather than passing for a block.
  assert.equal(observed.revoke_blocked_during_read, "pending");
  assert.equal(observed.racing_read_served, "ALLOWED");
  // A wait, not a deadlock: it goes through once the read commits.
  assert.equal(observed.revoke_completed_after_commit, "true");
  assert.equal(observed.revoke_outcome_after_commit, "fulfilled");

  // Expiry is judged by the database's clock. The second case runs the
  // identical call with this process convinced it is three hours ago,
  // when that grant was still live: a boundary reading `new Date()`
  // would allow it.
  assert.equal(observed.expired, "grant_expired");
  assert.equal(observed.expired_under_skewed_process_clock, "grant_expired");
});
