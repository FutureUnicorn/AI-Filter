import assert from "node:assert/strict";
import test from "node:test";

import { assertCandidateDecisionIntegrity } from "../../packages/db/src/index.ts";

// AF-51. The pure derivation is covered in tests/unit; this is the half
// only a real database can answer -- that applications holds no
// competing status column, that no decision can be recorded without a
// named member and a rationale, and that two reviewers deciding at once
// cannot fork the chain.

test("candidate decisions are the only status, always named, and never forked", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises candidate decisions against real Postgres"
    );
  }
  await assertCandidateDecisionIntegrity(databaseUrl);
});
