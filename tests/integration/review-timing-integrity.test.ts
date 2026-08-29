import assert from "node:assert/strict";
import test from "node:test";

import { assertReviewTimingIntegrity } from "../../packages/db/src/index.ts";

// AF-54. The summary arithmetic is pure and covered in tests/unit; this
// is the half only a real database can answer -- that a span cannot
// claim more active time than the wall clock it sits inside, cannot
// cross tenants, and cannot be edited after the fact.

test("review timing spans are bounded, attributed, tenant-scoped and immutable", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises review timing against real Postgres");
  }
  await assertReviewTimingIntegrity(databaseUrl);
});
