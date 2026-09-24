import assert from "node:assert/strict";
import test from "node:test";

import { assertPrivacyRequestExtension } from "../../packages/db/src/index.ts";

// AF-64 REV-001. Article 12(3) lets a controller take two further months,
// and an extension is the only thing that legitimately moves a request's
// due date. The mechanism was documented, validated in the domain and
// backed by CHECK constraints in 0024_privacy_requests.sql, but nothing
// could grant one. These drive extendPrivacyRequest itself against the
// real schema and the real database clock.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

async function observe(): Promise<Awaited<ReturnType<typeof assertPrivacyRequestExtension>>> {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the constraints, the append-only ledger and the database clock for real. See README.md."
    );
  }
  return assertPrivacyRequestExtension(DATABASE_URL);
}

test("a timely extension moves the due date, and says so on the request", async () => {
  const observed = await observe();
  assert.equal(observed.granted.dueAt, observed.expectedDueAt, "the new deadline is received_at plus 1 + 2 months");
  assert.equal(observed.storedDueAt, observed.expectedDueAt, "and it is what the row now holds");
  assert.notEqual(observed.granted.previousDueAt, observed.granted.dueAt);
  assert.ok(observed.storedExtendedAt !== null, "extended_at must be recorded");
  assert.equal(observed.storedExtensionReason, "a complex request spanning several roles");
});

test("the extension is recorded immutably, with who granted it and the deadline before and after", async () => {
  const observed = await observe();
  assert.ok(observed.ledgerRow !== null, "an extension must leave a row in privacy_request_extensions");
  assert.equal(observed.ledgerRow.extensionMonths, 2);
  assert.equal(observed.ledgerRow.previousDueAt, observed.granted.previousDueAt);
  assert.equal(observed.ledgerRow.newDueAt, observed.granted.dueAt);
  assert.equal(observed.ledgerRow.actorUserId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  // One instant, judged and written: the ledger and the request agree on
  // when the extension happened, to the database's own precision.
  assert.equal(observed.ledgerRow.extendedAtMatchesRequest, true);
  assert.match(observed.ledgerUpdateRejection, /append-only: UPDATE is not allowed/);
});

test("an in-progress request is still open and can be extended", async () => {
  const observed = await observe();
  assert.equal(observed.inProgressGranted, true);
});

test("a request can be extended only once, by the function and by the database", async () => {
  const observed = await observe();
  assert.match(observed.alreadyExtendedRejection, /already extended/);
  assert.equal(observed.ledgerRowsForAlreadyExtended, 1, "a refused second extension must write nothing");
  // A writer that bypasses the function meets UNIQUE (request_id).
  assert.match(observed.secondLedgerRowRejection, /privacy_request_extensions_request_id_key/);
});

test("an answered request cannot be extended, whether completed or refused", async () => {
  const observed = await observe();
  assert.match(observed.completedRejection, /completed, which is terminal/);
  assert.match(observed.refusedRejection, /refused, which is terminal/);
});

test("an extension after the first month is refused against the database clock", async () => {
  // Received 40 days ago, so the first month has passed whatever time it is
  // now. The caller cannot supply a time, so it cannot backdate one.
  const observed = await observe();
  assert.match(observed.outOfWindowRejection, /first month has passed/);
  assert.equal(observed.outOfWindowDueAtUnchanged, true, "a refused extension must leave the deadline alone");
});

test("an extension must be one or two months, in the domain and in the schema", async () => {
  const observed = await observe();
  assert.match(observed.zeroMonthsRejection, /from 1 to 2, got: 0/);
  assert.match(observed.threeMonthsRejection, /from 1 to 2, got: 3/);
  assert.match(observed.zeroMonthsLedgerRejection, /privacy_request_extensions_extension_months_check/);
});

test("one organization cannot extend another's request", async () => {
  const observed = await observe();
  assert.match(observed.crossTenantRejection, /no request .* in organization 22222222/);
});
