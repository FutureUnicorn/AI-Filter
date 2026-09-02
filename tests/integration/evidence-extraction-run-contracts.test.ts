import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import { evidenceExtractionRunSchema } from "../../packages/contracts/src/index.ts";
import { assertExtractionRunOrganizationDelete } from "../../packages/db/src/index.ts";

const base = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  runId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  entityType: "application",
  entityId: "app-123",
  provider: "openai",
  model: "gpt-5.6",
  promptVersion: "v1",
  extractionSchemaVersion: "1.0.0",
  extractionSchemaName: "evidence_response",
  rubricVersion: "rubric-v3",
  createdAt: "2026-08-21T12:00:00.000Z"
};

test("a well-formed evidence extraction run parses successfully", () => {
  assert.equal(evidenceExtractionRunSchema.safeParse(base).success, true);
});

test("extractionSchemaVersion is distinct from the record's own schemaVersion", () => {
  // Both fields exist and can legitimately differ: the record's contract
  // version (CONTRACT_SCHEMA_VERSION) versus the AI extraction schema's
  // own version (whatever AF-35's EVIDENCE_EXTRACTION_SCHEMA_VERSION is).
  const result = evidenceExtractionRunSchema.safeParse({
    ...base,
    extractionSchemaVersion: "2.0.0"
  });
  assert.equal(result.success, true);
});

test("every required field is actually required, not optional", () => {
  for (const field of Object.keys(base)) {
    const withoutField: Record<string, unknown> = { ...base };
    delete withoutField[field];
    const result = evidenceExtractionRunSchema.safeParse(withoutField);
    assert.equal(result.success, false, `${field} should be required`);
  }
});

test("an empty string for a required text field is rejected, not silently accepted", () => {
  const result = evidenceExtractionRunSchema.safeParse({ ...base, rubricVersion: "" });
  assert.equal(result.success, false);
});

test("an unrecognized property is rejected", () => {
  const result = evidenceExtractionRunSchema.safeParse({ ...base, notes: "extra" });
  assert.equal(result.success, false);
});

test("a stale schemaVersion is rejected", () => {
  const result = evidenceExtractionRunSchema.safeParse({ ...base, schemaVersion: "0.9.0" });
  assert.equal(result.success, false);
});

// AF-40 review (#23). ON DELETE CASCADE on organization_id fought the
// append-only trigger, so offboarding an organization failed while naming
// the trigger rather than the reference that actually blocks it.

test("deleting an organization is refused by the foreign key, not by the append-only trigger", async () => {
  const databaseUrl = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set. See README.md.");
  }
  const { message } = await assertExtractionRunOrganizationDelete(databaseUrl);
  assert.match(message, /violates foreign key constraint/);
  assert.match(message, /evidence_extraction_runs_organization_id_fkey/);
  // The failure it used to give. An operator debugging a blocked
  // offboarding would have been sent to the wrong constraint entirely.
  assert.doesNotMatch(message, /append-only/);
});
