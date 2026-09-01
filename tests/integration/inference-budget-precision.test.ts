import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInferenceBudgetPrecision,
  reserveInferenceBudget
} from "../../packages/db/src/index.ts";

// AF-41 review (#24). The ledger columns are bigint, which Postgres returns
// as a string precisely because the value may not fit a JS number. Feeding
// those through Number() makes a budget comparison quietly wrong at a
// threshold nobody is watching for.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

function requireDatabase(): string {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set. See README.md.");
  }
  return DATABASE_URL;
}

test("a total past MAX_SAFE_INTEGER is refused, not silently rounded", async () => {
  const observed = await assertInferenceBudgetPrecision(requireDatabase());
  // The failure mode being prevented, shown rather than described: this is
  // the number Number() would have returned for the stored value.
  assert.equal(observed.storedValue, "9007199254740993");
  assert.equal(observed.silentlyRoundedValue, 9007199254740992);
  assert.notEqual(String(observed.silentlyRoundedValue), observed.storedValue);
  assert.match(observed.oversizedReadRejection, /silently lost precision/);
  assert.match(observed.oversizedReadRejection, /input_tokens/);
});

test("the cap_exceeded path reports the real committed total", async () => {
  // Read back on the connection already open rather than through a second
  // one; the value has to stay correct either way.
  const observed = await assertInferenceBudgetPrecision(requireDatabase());
  assert.equal(observed.capExceededTotalBefore, 1000);
});

test("a nonsensical cap is rejected at the boundary, not by a SQL cast", async () => {
  // Unvalidated, these reach `$7::bigint` and fail inside Postgres with a
  // message naming neither the field nor the caller. A negative cap is
  // worse than an error: every reservation would report cap_exceeded, which
  // looks like a budget decision rather than a bad argument.
  const databaseUrl = requireDatabase();
  const base = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    model: "gpt-5.6",
    periodStart: "2026-09-01",
    inputTokens: 1,
    outputTokens: 1
  };
  for (const maxTotalTokens of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => reserveInferenceBudget(databaseUrl, "public", { ...base, maxTotalTokens }),
      /non-negative safe integer maxTotalTokens/,
      `maxTotalTokens ${maxTotalTokens} was accepted`
    );
  }
});
