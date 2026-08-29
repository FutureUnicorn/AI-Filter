import assert from "node:assert/strict";
import test from "node:test";

import { assertEvidenceCorrectionsAppendOnly } from "../../packages/db/src/index.ts";

// AF-49. The pure chain logic is covered in tests/unit; this is the half
// only a real database can answer -- that the original survives, that a
// correction is attributed and linked, and that two recruiters
// correcting at the same moment cannot fork the history.

test("evidence corrections append, attribute, chain, and survive concurrency", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises evidence corrections against real Postgres"
    );
  }
  await assertEvidenceCorrectionsAppendOnly(databaseUrl);
});
