import assert from "node:assert/strict";
import test from "node:test";

import { assertFileIntakeTenantIntegrity } from "../../packages/db/src/index.ts";

test("a file intake cannot reference another organization's role", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test exercises " +
        "packages/db/migrations/0012_file_intakes.sql for real. Locally: run `pnpm dev:infra`, then set it to " +
        "postgresql://signal_audit_local:local-only-password@localhost:5432/signal_audit_local (see README.md)."
    );
  }
  await assertFileIntakeTenantIntegrity(databaseUrl);
});
