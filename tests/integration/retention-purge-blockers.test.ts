import assert from "node:assert/strict";
import test from "node:test";

import { assertRetentionPurgeBlockers } from "../../packages/db/src/index.ts";
import { RETENTION_SURFACES, planRetention } from "../../packages/domain/src/index.ts";
import type { RetentionSurface } from "../../packages/domain/src/index.ts";

// AF-61. The retention plan CLAIMS a disposition for every surface.
// Those claims end up in a privacy notice, so they are proved against
// the real migrations rather than left resting on a reading of them.
//
// Both directions. The first revision proved only the blocked surfaces,
// and two of the three it left unproved turned out to be wrong in the
// other direction: the plan called canonical_text_extractions and
// import_rows blocked when the database deletes them on request.

const DATABASE_URL = process.env["SIGNAL_AUDIT_RLS_DATABASE_URL"];

/** Surfaces that are tables in this database, so the probe can reach them. */
const PROBED_SURFACES: readonly RetentionSurface[] = [
  "file_intakes",
  "canonical_text_extractions",
  "import_rows",
  "applications",
  "evidence_outcomes",
  "candidate_decisions"
];

function databaseUrl(): string {
  if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
    assert.fail(
      "SIGNAL_AUDIT_RLS_DATABASE_URL must be set to a real Postgres connection string so this test " +
        "exercises the append-only triggers and foreign keys for real. See README.md."
    );
  }
  return DATABASE_URL;
}

test("every purge path the plan calls blocked really is refused by the database", async () => {
  const { failures } = await assertRetentionPurgeBlockers(databaseUrl());

  // Named individually rather than counted: a count would still pass if
  // one blocker were replaced by an unrelated failure. The probe itself
  // additionally checks the SQLSTATE and, for a referential refusal, the
  // constraint that refused, so a typo cannot present itself as a
  // blocker here.
  assert.match(failures["evidence_outcomes:delete"] ?? "", /append-only: DELETE is not allowed/);
  assert.match(failures["evidence_outcomes:redact"] ?? "", /append-only: UPDATE is not allowed/);
  assert.match(failures["candidate_decisions:delete"] ?? "", /append-only: DELETE is not allowed/);
  assert.match(failures["candidate_decisions:redact"] ?? "", /append-only: UPDATE is not allowed/);
  assert.match(failures["applications:delete"] ?? "", /violates foreign key constraint/);
  assert.match(failures["applications:delete"] ?? "", /evidence_outcomes/);
  assert.match(failures["file_intakes:delete"] ?? "", /violates foreign key constraint/);
});

test("candidate_decisions blocks deleting an application on its own, not only alongside evidence", async () => {
  // REV-002. Two uncascaded foreign keys reference applications and
  // Postgres names only the first one it checks, so an application
  // carrying both dependents proves one and hides the other. This one
  // carries a decision and no evidence.
  const { failures } = await assertRetentionPurgeBlockers(databaseUrl());
  const refusal = failures["applications:delete_pinned_only_by_a_decision"] ?? "";
  assert.match(refusal, /violates foreign key constraint/);
  assert.match(refusal, /candidate_decisions_application_id_organization_id_fkey/);
  assert.ok(
    !refusal.includes("evidence_outcomes"),
    "this case has to be blocked by candidate_decisions alone, or it proves nothing new"
  );
});

test("the quote cannot even be redacted in place, which is why this is not a small fix", async () => {
  // Worth its own assertion: if UPDATE were allowed, retention could
  // blank the quote and keep the audit row, and the whole problem would
  // be a one-line purge job rather than a schema decision.
  const { failures } = await assertRetentionPurgeBlockers(databaseUrl());
  assert.ok(
    (failures["evidence_outcomes:redact"] ?? "").includes("UPDATE is not allowed"),
    "an in-place redaction path would change the whole shape of this ticket"
  );
  assert.ok(
    (failures["candidate_decisions:redact"] ?? "").includes("UPDATE is not allowed"),
    "the same holds for a decision rationale, which is free text a human wrote about a candidate"
  );
});

test("the surfaces the plan says can be purged really are deleted when asked", async () => {
  // The direction the first revision never checked. canonical_text is
  // the largest store of raw candidate text in the product, so a plan
  // calling it unpurgeable sends a privacy notice out saying it is kept
  // when it need not be.
  const { permitted } = await assertRetentionPurgeBlockers(databaseUrl());
  assert.equal(permitted["canonical_text_extractions:delete"], 1);
  assert.equal(permitted["import_rows:delete"], 1);
  // And the cascade the plan describes is real where nothing pins the
  // parent, which is what makes "blocked while an application references
  // the intake" a statement about the reference and not about the table.
  assert.equal(permitted["file_intakes:delete_when_unreferenced"], 1);
  assert.equal(permitted["canonical_text_extractions:cascade_from_file_intakes"], 1);
  assert.equal(permitted["import_rows:cascade_from_file_intakes"], 1);
});

test("what the database refuses matches what the plan says it refuses, surface by surface", async () => {
  // Two readings that have to agree, across every surface the probe can
  // reach rather than a hand-picked three. A migration that unblocks a
  // path, or pins a currently free one, fails here either way.
  const { failures, permitted } = await assertRetentionPurgeBlockers(databaseUrl());
  const plan = planRetention(
    { organizationId: "11111111-1111-4111-8111-111111111111", windowDays: 30 },
    new Date("2026-08-29T12:00:00.000Z")
  );

  // A surface added to the plan without a probe is the exact gap
  // REV-001 reported, so make it fail rather than rely on remembering.
  // Only two can legitimately go unprobed: object storage is not in this
  // database, and audit_events' claim is about what it holds rather than
  // what the schema permits, which no DELETE can settle.
  assert.deepEqual(
    RETENTION_SURFACES.filter((surface) => !PROBED_SURFACES.includes(surface)),
    ["object_storage_documents", "audit_events"],
    "a new retention surface needs a probe, or a stated reason it cannot have one"
  );

  const dispositionOf = new Map(plan.surfaces.map((surface) => [surface.surface, surface.disposition]));
  // Only the two actions a retention run would issue against a
  // candidate's own rows. The probe's other labels are controls:
  // file_intakes:delete_when_unreferenced deletes an intake no
  // application points at, which is not a row retention would ever meet
  // on its own, and counting it here would read as "file_intakes is
  // purgeable" when for a real candidate it is not.
  const surfacesWithAction = (labels: readonly string[]): ReadonlySet<string> =>
    new Set(
      labels
        .map((label) => label.split(":"))
        .filter(([, action]) => action === "delete" || action === "redact")
        .map(([surface]) => surface ?? "")
    );
  const refused = surfacesWithAction(Object.keys(failures));
  const deleted = surfacesWithAction(Object.keys(permitted));

  for (const surface of PROBED_SURFACES) {
    const disposition = dispositionOf.get(surface);
    assert.ok(disposition !== undefined, `${surface} is missing from the plan entirely`);
    if (disposition.startsWith("blocked")) {
      assert.ok(refused.has(surface), `the plan says ${surface} is blocked, but the database did not refuse it`);
      assert.ok(!deleted.has(surface), `the plan says ${surface} is blocked, but the probe deleted rows from it`);
    } else {
      assert.ok(
        deleted.has(surface),
        `the plan says ${surface} can be purged (${disposition}), but the probe never deleted a row from it`
      );
      assert.ok(!refused.has(surface), `the plan says ${surface} can be purged, but the database refused it`);
    }
  }

  // Not a bare subset check: every surface the probe reported on must be
  // one the plan actually names, so a label typo cannot quietly count as
  // coverage for a surface nobody tested.
  for (const label of [...Object.keys(failures), ...Object.keys(permitted)]) {
    const surface = label.split(":")[0] ?? "";
    assert.ok(
      (RETENTION_SURFACES as readonly string[]).includes(surface),
      `the probe reported on "${surface}", which is not a surface in the plan`
    );
  }
});
