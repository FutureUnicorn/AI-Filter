import assert from "node:assert/strict";
import test from "node:test";

import { assertAuditSampleIntegrity } from "../../packages/db/src/index.ts";

// AF-52. The selection logic is pure and covered in tests/unit; this is
// the half only a real database can answer -- that a recorded draw
// cannot be re-rolled, re-attributed or quietly extended, and that a
// draw which cannot record its members records nothing at all.

test("a recorded audit sample is immutable, attributed, and atomic", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises audit sampling against real Postgres");
  }
  await assertAuditSampleIntegrity(databaseUrl);
});
