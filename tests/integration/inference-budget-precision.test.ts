import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInferenceBudgetAtomicity,
  assertInferenceBudgetPrecision,
  assertInferenceReservationSettlement,
  recordInferenceUsage,
  reserveInferenceBudget,
  settleInferenceReservation
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

test("concurrent reservations near the cap cannot overspend it", async () => {
  // The P1 this ticket's review raised. A sequential loop cannot show it:
  // the broken read-then-write version passes that just as happily. Thirty
  // reservations of 100 fire in parallel against a cap of 1000, so only ten
  // can legitimately win, and the observation records what the pattern this
  // replaced does under the identical burst.
  const observed = await assertInferenceBudgetAtomicity(requireDatabase());
  assert.equal(observed.cap, 1000);
  assert.equal(observed.reserved, 10, "exactly ten reservations of 100 fit under a 1000 cap");
  assert.equal(observed.totalAfter, 1000);
  assert.ok(
    observed.totalAfter <= observed.cap,
    `committed ${observed.totalAfter} against a cap of ${observed.cap}`
  );
  // The failure mode being prevented, shown rather than described.
  assert.ok(
    observed.naiveTotalAfter > observed.cap,
    "read-then-write should overspend here; if it no longer does, this test has stopped proving anything"
  );
});

test("a negative usage delta cannot walk the meter backwards", async () => {
  // The table CHECK only sees the result of the addition, so -50 against a
  // committed 100 lands as 50 and postpones the cap. Rejected at the
  // boundary instead, on both write paths.
  const databaseUrl = requireDatabase();
  const base = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    model: "gpt-5.6",
    periodStart: "2026-09-01"
  };
  for (const [inputTokens, outputTokens] of [
    [-50, 0],
    [0, -1],
    [1.5, 0]
  ] as const) {
    await assert.rejects(
      () => recordInferenceUsage(databaseUrl, "public", { ...base, inputTokens, outputTokens }),
      /non-negative safe integer/,
      `recordInferenceUsage accepted ${inputTokens}/${outputTokens}`
    );
    await assert.rejects(
      () =>
        reserveInferenceBudget(databaseUrl, "public", {
          ...base,
          inputTokens,
          outputTokens,
          maxTotalTokens: 1_000
        }),
      /non-negative safe integer/,
      `reserveInferenceBudget accepted ${inputTokens}/${outputTokens}`
    );
  }
});

// AF-41 review round two (#24), the two P1s and the safe-sum P2.

test("a zero-token reservation is refused, so a cap cannot be walked past", async () => {
  // Both guards are `<=`, so a caller sitting exactly at its cap satisfied
  // `total + 0 <= cap` and was told `reserved`, forever. A caller with no
  // pre-call estimate could reserve nothing repeatedly and keep calling the
  // provider after the budget should have blocked everything. It also
  // contradicted the domain, where zero usage against a zero cap is capped.
  const databaseUrl = requireDatabase();
  const base = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    model: "gpt-5.6",
    periodStart: "2026-09-01",
    maxTotalTokens: 1000
  };
  await assert.rejects(
    () => reserveInferenceBudget(databaseUrl, "public", { ...base, inputTokens: 0, outputTokens: 0 }),
    /requires a positive token estimate/
  );
});

test("settling a reservation replaces the estimate instead of adding to it", async () => {
  // The other P1. A reservation is written before the call, when only an
  // estimate exists, into the same columns that afterwards hold real usage.
  // Recording usage on top of it counted the call twice.
  const observed = await assertInferenceReservationSettlement(requireDatabase());

  assert.deepEqual(observed.overEstimate, { inputTokens: 45, outputTokens: 25 }, "the over-estimate refunded");
  assert.deepEqual(observed.underEstimate, { inputTokens: 30, outputTokens: 15 }, "the under-estimate topped up");

  // The failure mode being prevented, shown rather than described: reserving
  // 100 and consuming 70 used to leave 170 in the ledger the cap reads.
  assert.equal(observed.doubleCountedTotal, 170);
  assert.equal(observed.overEstimate.inputTokens + observed.overEstimate.outputTokens, 70);
});

test("retrying settlement after a committed response cannot adjust the ledger twice", async () => {
  // A worker can commit settlement and lose the response before it knows that
  // it succeeded. Retrying must report the already-settled reservation rather
  // than applying its refund/top-up a second time.
  const observed = await assertInferenceReservationSettlement(requireDatabase());
  assert.equal(observed.duplicateSettlement, "already_settled");
  assert.deepEqual(observed.overEstimate, { inputTokens: 45, outputTokens: 25 });
});

test("settlement rejects nonsensical token counts at the boundary", async () => {
  const databaseUrl = requireDatabase();
  const base = {
    reservationId: "11111111-1111-4111-8111-111111111111",
    actualInputTokens: 1,
    actualOutputTokens: 1
  };
  for (const field of [
    "actualInputTokens",
    "actualOutputTokens"
  ] as const) {
    await assert.rejects(
      () => settleInferenceReservation(databaseUrl, "public", { ...base, [field]: Number.NaN }),
      new RegExp(`non-negative safe integer ${field}`),
      `${field} accepted NaN`
    );
  }
});
