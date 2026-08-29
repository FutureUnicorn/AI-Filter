import assert from "node:assert/strict";
import test from "node:test";

import { failedDocumentRateSchema } from "../../packages/contracts/src/index.ts";
import { assertFailedDocumentRateAccuracy } from "../../packages/db/src/index.ts";
import { summarizeFailedDocuments } from "../../packages/domain/src/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const ROLE = "22222222-2222-4222-8222-222222222222";

test("summarizeFailedDocuments output satisfies the published contract", () => {
  const parsed = failedDocumentRateSchema.safeParse(
    summarizeFailedDocuments(ORG, ROLE, {
      uploaded: 10,
      quarantined: 1,
      rejected: 1,
      extractionEmpty: 1,
      extractionSucceeded: 4
    })
  );
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("the contract accepts a null rate and rejects an out-of-range one", () => {
  const base = summarizeFailedDocuments(ORG, ROLE, {
    uploaded: 3,
    quarantined: 0,
    rejected: 0,
    extractionEmpty: 0,
    extractionSucceeded: 0
  });
  assert.equal(base.failedRate, null);
  assert.equal(failedDocumentRateSchema.safeParse(base).success, true);
  // A rate above 1 cannot be produced by summarizeFailedDocuments, but the
  // schema is the boundary for anything crossing a wire, so it has to
  // reject one on its own rather than trusting its producer.
  assert.equal(failedDocumentRateSchema.safeParse({ ...base, failedRate: 1.5 }).success, false);
  assert.equal(failedDocumentRateSchema.safeParse({ ...base, failedRate: -0.1 }).success, false);
});

test("the failed-document rate is counted correctly by a real database", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test exercises " +
        "the AF-58 aggregate against packages/db/migrations for real. Locally: run `pnpm dev:infra`, then set it " +
        "to postgresql://signal_audit_local:local-only-password@localhost:5432/signal_audit_local (see README.md)."
    );
  }
  await assertFailedDocumentRateAccuracy(databaseUrl);
});
