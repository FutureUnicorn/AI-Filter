import assert from "node:assert/strict";
import test from "node:test";

import { assertEvidenceOutcomePersistence } from "../../packages/db/src/index.ts";

// AF-48 prerequisite. The evidence card is only as trustworthy as the
// table under it: if a correction does not supersede, or a tenant can
// read another's evidence, or a recorded outcome can be edited after the
// fact, the card is confidently wrong rather than merely missing.

test("evidence outcomes are append-only, tenant-scoped, and superseded newest-first", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises evidence outcome persistence against real Postgres"
    );
  }
  await assertEvidenceOutcomePersistence(databaseUrl);
});
