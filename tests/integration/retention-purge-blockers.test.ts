import assert from "node:assert/strict";
import test from "node:test";

import { assertRetentionPurgeBlockers } from "../../packages/db/src/index.ts";
import { planRetention } from "../../packages/domain/src/index.ts";

// AF-61. The retention plan CLAIMS certain surfaces cannot be purged.
// That claim ends up in a privacy notice, so it is proved against the
// real migrations rather than left resting on a reading of them.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

test("every purge path the plan calls blocked really is refused by the database", async () => {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the append-only triggers and foreign keys for real. See README.md."
    );
  }
  const failures = await assertRetentionPurgeBlockers(DATABASE_URL);

  // Named individually rather than counted: a count would still pass if
  // one blocker were replaced by an unrelated failure.
  assert.match(failures["evidence_outcomes:delete"] ?? "", /append-only: DELETE is not allowed/);
  assert.match(failures["evidence_outcomes:redact"] ?? "", /append-only: UPDATE is not allowed/);
  assert.match(failures["applications:delete"] ?? "", /violates foreign key constraint/);
  assert.match(failures["applications:delete"] ?? "", /evidence_outcomes/);
  assert.match(failures["file_intakes:delete"] ?? "", /violates foreign key constraint/);
});

test("the quote cannot even be redacted in place, which is why this is not a small fix", async () => {
  // Worth its own assertion: if UPDATE were allowed, retention could
  // blank the quote and keep the audit row, and the whole problem would
  // be a one-line purge job rather than a schema decision.
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set");
  }
  const failures = await assertRetentionPurgeBlockers(DATABASE_URL);
  assert.ok(
    (failures["evidence_outcomes:redact"] ?? "").includes("UPDATE is not allowed"),
    "an in-place redaction path would change the whole shape of this ticket"
  );
});

test("what the database refuses matches what the plan says it refuses", async () => {
  // Two readings that have to agree. If a migration ever unblocks one of
  // these, the plan becomes wrong in the other direction -- still wrong,
  // and still worth failing over.
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set");
  }
  const failures = await assertRetentionPurgeBlockers(DATABASE_URL);
  const plan = planRetention(
    { organizationId: "11111111-1111-4111-8111-111111111111", windowDays: 30 },
    new Date("2026-08-29T12:00:00.000Z")
  );

  const claimedBlocked = new Set(
    plan.surfaces
      .filter((surface) => surface.disposition.startsWith("blocked"))
      .map((surface) => surface.surface)
  );
  for (const surface of ["evidence_outcomes", "applications", "file_intakes"]) {
    assert.ok(claimedBlocked.has(surface as never), `plan does not claim ${surface} is blocked`);
    assert.ok(
      Object.keys(failures).some((label) => label.startsWith(`${surface}:`)),
      `database did not refuse any purge of ${surface}, but the plan says it is blocked`
    );
  }
});
