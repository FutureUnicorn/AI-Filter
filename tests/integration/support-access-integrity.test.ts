import assert from "node:assert/strict";
import test from "node:test";

import { assertSupportAccessIntegrity } from "../../packages/db/src/index.ts";

// AF-66. The domain refuses support access without a live grant; these
// prove the database refuses the grants that should never exist in the
// first place. A rule enforced only in the application layer is a rule
// that a direct psql session, a migration script or a future endpoint
// can walk around.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

async function rejections(): Promise<Record<string, string>> {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string");
  }
  return assertSupportAccessIntegrity(DATABASE_URL);
}

test("an operator cannot grant themselves access to a tenant", async () => {
  // The whole point of naming a second person is that someone else knew.
  // Self-granted access is not a control, it is a formality.
  const found = await rejections();
  assert.match(found["self_granted"] ?? "", /support_access_grants_not_self_granted/);
});

test("a reason of only whitespace is refused by the database, not just the app", () => {
  // Postgres trim() strips spaces only, so length(trim(reason)) > 0 would
  // accept a reason of tabs and newlines. The check is a character class
  // for exactly that reason.
  return rejections().then((found) => {
    assert.match(found["whitespace_reason"] ?? "", /reason/);
  });
});

test("a grant longer than a day is refused", async () => {
  // An unbounded grant is indistinguishable from permanent access, and
  // nobody remembers to revoke.
  const found = await rejections();
  assert.match(found["window_too_long"] ?? "", /support_access_grants_bounded_window/);
});

test("a grant that expires before it starts is refused", async () => {
  const found = await rejections();
  assert.match(found["expires_before_grant"] ?? "", /support_access_grants_expires_after_grant/);
});

test("an access event cannot cite a grant issued for a different tenant", async () => {
  // The composite key. Without it an event could name tenant B while
  // pointing at a grant that only ever authorised tenant A -- and the
  // access log for B would show an authorisation that does not exist.
  const found = await rejections();
  assert.match(found["event_cites_other_org_grant"] ?? "", /violates foreign key constraint/);
});

test("an access event with a blank entity id is refused", async () => {
  const found = await rejections();
  assert.match(found["event_blank_entity_id"] ?? "", /entity_id/);
});

test("access events cannot be deleted or edited afterwards", async () => {
  // The one person with a motive to remove a row is the person the row is
  // about.
  const found = await rejections();
  assert.match(found["event_delete"] ?? "", /append-only: DELETE is not allowed/);
  assert.match(found["event_update"] ?? "", /append-only: UPDATE is not allowed/);
});

test("a grant's reason and window cannot be amended after the fact", async () => {
  // Amendable terms would let the record be rewritten to match whatever
  // was actually done, which is worse than no record.
  const found = await rejections();
  assert.match(found["grant_reason_amended"] ?? "", /only revoked_at may be updated/);
  assert.match(found["grant_window_extended"] ?? "", /only revoked_at may be updated/);
  assert.match(found["grant_delete"] ?? "", /DELETE is not allowed/);
});

test("revocation is permitted once and cannot be undone", async () => {
  // Revoking early is a safety property, so grants are not fully
  // append-only. Un-revoking would turn that safety valve into a way to
  // reopen access without a new authorisation.
  const found = await rejections();
  assert.match(found["revocation_undone"] ?? "", /revoked_at cannot be changed once set/);
});
