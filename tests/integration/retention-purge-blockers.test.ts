import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  "candidate_decisions",
  // REV-001. audit_events used to be excused from probing on the grounds
  // that its claim was about what it holds rather than what the schema
  // permits. That was the wrong shape of excuse: the claim was that it
  // holds nothing candidate-derived, and it holds the application
  // identifier, so the claim it now makes -- that the identifier can be
  // neither deleted nor redacted -- is one a DELETE and an UPDATE settle
  // exactly.
  "audit_events",
  "evidence_extraction_runs"
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

test("each of the five blockers refuses deleting an application on its own", async () => {
  // REV-003. The plan once said two uncascaded FKs pin applications;
  // pg_constraint over every migration shows five blockers. Each case
  // here is an application the probe has first proved carries exactly
  // one dependent, so the refusal cannot be borrowed from another.
  const { failures } = await assertRetentionPurgeBlockers(databaseUrl());
  const cases = [
    ["applications:delete", "evidence_outcomes_application_id_organization_id_fkey"],
    ["applications:delete_pinned_only_by_a_decision", "candidate_decisions_application_id_organization_id_fkey"],
    ["applications:delete_pinned_only_by_an_audit_sample", "audit_sample_members_application_id_organization_id_fkey"],
    ["applications:delete_pinned_only_by_a_timing_span", "review_timing_spans_application_id_organization_id_fkey"]
  ] as const;
  for (const [label, constraint] of cases) {
    const refusal = failures[label] ?? "";
    assert.match(refusal, /violates foreign key constraint/, `${label} must be refused by a foreign key`);
    assert.ok(refusal.includes(constraint), `${label} must be refused by ${constraint}, got: ${refusal}`);
  }
  // Not a foreign key violation: the FK is ON DELETE SET NULL and would
  // allow it. The ledger's CHECK is what refuses the null.
  const imported = failures["applications:delete_pinned_only_by_an_import_row"] ?? "";
  assert.match(imported, /violates check constraint "import_rows_check"/);
  assert.doesNotMatch(imported, /foreign key/);
});

test("purging import_rows first is what lets an import-pinned application go", async () => {
  // The ordering the plan states, walked rather than asserted: once the
  // processed ledger row is gone, nothing else pins that application.
  const { permitted } = await assertRetentionPurgeBlockers(databaseUrl());
  assert.equal(permitted["import_rows:delete_processed_row"], 1);
  assert.equal(permitted["applications:delete_after_import_rows_purged"], 1);
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

  // A surface added to the plan without a probe is the exact gap the
  // first round reported, so make it fail rather than rely on
  // remembering. Exactly one can legitimately go unprobed: object
  // storage is not in this database at all.
  assert.deepEqual(
    RETENTION_SURFACES.filter((surface) => !PROBED_SURFACES.includes(surface)),
    ["object_storage_documents"],
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

// ---- REV-004: prove against the whole schema, and read it from pg_constraint ----
//
// The probe used to apply a hand-picked list of migrations, so it could
// only find blockers in tables someone had already thought of, which is how
// REV-003's five blockers on applications were reported as two. The
// cross-check above fails when the PLAN gains a surface without a probe;
// nothing failed when the SCHEMA gained a table referencing a planned
// surface. These close that direction.

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../packages/db/migrations");

/**
 * Foreign keys onto a planned surface from a table the plan does not name.
 *
 * Self-expiring rather than permanent: every entry is re-proved on every
 * run, and fails the moment it stops being true -- if the foreign key is
 * gone, if the plan starts naming the table, or if the table gains any
 * column not listed here, which is exactly when someone has to look again
 * at whether it now holds candidate data. AF-63's RETENTION_EXEMPT_TABLES,
 * further up this stack, is the eventual owner of table exemptions; fold
 * this into it when that lands rather than keeping two lists.
 */
const REFERENCE_EXEMPTIONS: ReadonlyArray<{
  readonly referencing: string;
  readonly referenced: RetentionSurface;
  readonly columns: readonly string[];
  readonly reason: string;
}> = [
  {
    referencing: "import_finalizations",
    referenced: "file_intakes",
    columns: ["created_at", "finalization_id", "idempotency_key", "intake_id", "mapping"],
    reason:
      "mapping is CsvColumnMapping[]: the employer's CSV header names and the fields they map to, " +
      "not candidate content. It cascades away with its file_intake and pins nothing."
  }
];

test("the probe applies every migration, in the order the migrate service applies them", async () => {
  const { appliedMigrations } = await assertRetentionPurgeBlockers(databaseUrl());
  // Read independently of the probe's own helper, so the two readings have
  // to agree rather than one checking itself.
  const onDisk = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assert.deepEqual(appliedMigrations, onDisk, "the probe must apply the whole directory, not a subset");
  // The duplicate prefix, in the order every environment has run it.
  const first = appliedMigrations.indexOf("0009_inference_kill_switch_nonblank_reason.sql");
  const second = appliedMigrations.indexOf("0009_roles.sql");
  assert.ok(first >= 0 && second >= 0, "both files sharing the 0009 prefix must be applied");
  assert.ok(first < second, "bytewise order, as the runner's shell glob sorts");
});

test("pg_constraint is really being read, so the reference check cannot pass vacuously", async () => {
  const { foreignKeys } = await assertRetentionPurgeBlockers(databaseUrl());
  const ontoApplications = new Set(
    foreignKeys.filter((fk) => fk.referenced === "applications").map((fk) => fk.referencing)
  );
  for (const table of [
    "evidence_outcomes",
    "candidate_decisions",
    "audit_sample_members",
    "review_timing_spans",
    "import_rows"
  ]) {
    assert.ok(ontoApplications.has(table), `expected the known ${table} -> applications foreign key`);
  }
});

test("every table referencing a planned surface is in the plan or named in that surface's detail", async () => {
  const { foreignKeys } = await assertRetentionPurgeBlockers(databaseUrl());
  const plan = planRetention(
    { organizationId: "11111111-1111-4111-8111-111111111111", windowDays: 30 },
    new Date("2026-08-29T12:00:00.000Z")
  );
  const detailOf = new Map(plan.surfaces.map((surface) => [surface.surface as string, surface.detail]));
  const planned = new Set<string>(RETENTION_SURFACES);

  const unaccounted = foreignKeys
    .filter((fk) => planned.has(fk.referenced))
    .filter((fk) => !planned.has(fk.referencing))
    .filter((fk) => !new RegExp(`\\b${fk.referencing}\\b`, "u").test(detailOf.get(fk.referenced) ?? ""))
    .filter(
      (fk) =>
        !REFERENCE_EXEMPTIONS.some(
          (exemption) => exemption.referencing === fk.referencing && exemption.referenced === fk.referenced
        )
    )
    .map((fk) => `${fk.referencing} -> ${fk.referenced} (${fk.constraint})`);

  assert.deepEqual(
    unaccounted,
    [],
    "a table references a planned surface but the plan never mentions it, so its effect on retention is " +
      "unstated. Name it in that surface's detail, add it to RETENTION_SURFACES, or exempt it with its columns."
  );
});

test("every reference exemption is still true, or it has to go", async () => {
  const { foreignKeys, tableColumns } = await assertRetentionPurgeBlockers(databaseUrl());
  const plan = planRetention(
    { organizationId: "11111111-1111-4111-8111-111111111111", windowDays: 30 },
    new Date("2026-08-29T12:00:00.000Z")
  );
  const detailOf = new Map(plan.surfaces.map((surface) => [surface.surface as string, surface.detail]));
  for (const exemption of REFERENCE_EXEMPTIONS) {
    const label = `${exemption.referencing} -> ${exemption.referenced}`;
    assert.ok(
      foreignKeys.some((fk) => fk.referencing === exemption.referencing && fk.referenced === exemption.referenced),
      `${label} no longer exists; remove the exemption`
    );
    assert.ok(
      !(RETENTION_SURFACES as readonly string[]).includes(exemption.referencing) &&
        !new RegExp(`\\b${exemption.referencing}\\b`, "u").test(detailOf.get(exemption.referenced) ?? ""),
      `${label} is now accounted for by the plan; remove the exemption`
    );
    assert.deepEqual(
      tableColumns[exemption.referencing] ?? [],
      [...exemption.columns].sort(),
      `${exemption.referencing} changed shape; re-check that it still holds no candidate data, then update ` +
        `the exemption (${exemption.reason})`
    );
  }
});

// ---- REV-001: the surfaces no foreign key can find ----
//
// The reference inventory above reads pg_constraint, so it can only find
// a table that declares its association. audit_events and
// evidence_extraction_runs associate with an application through an
// entity_type/entity_id text pair, which pg_constraint has nothing to
// say about. One was therefore missing from the plan entirely and the
// other sat in it classified as holding nothing candidate-derived, and
// neither failure could have been caught by a check that looks for
// foreign keys.
//
// So this reads the columns instead. Any table carrying the pair can
// name an application, and a table that can name an application is in
// scope for retention whether or not anyone remembered to say so.

/**
 * Tables carrying the polymorphic pair that are nonetheless out of
 * retention scope.
 *
 * Empty, deliberately, and the test below still runs over it: an
 * exemption has to state the entity types that table actually writes,
 * and that claim is checked, so the list cannot become a place to put
 * things nobody wants to think about. Prefer adding the table to
 * RETENTION_SURFACES over adding it here.
 */
const POLYMORPHIC_ENTITY_EXEMPTIONS: ReadonlyArray<{
  readonly table: string;
  readonly reason: string;
}> = [];

function polymorphicTables(tableColumns: Readonly<Record<string, readonly string[]>>): readonly string[] {
  return Object.entries(tableColumns)
    .filter(([, columns]) => columns.includes("entity_type") && columns.includes("entity_id"))
    .map(([table]) => table)
    .sort();
}

test("every table carrying an entity_type/entity_id pair is a planned retention surface", async () => {
  const { tableColumns } = await assertRetentionPurgeBlockers(databaseUrl());
  const polymorphic = polymorphicTables(tableColumns);

  // Not vacuous: these two are why the check exists, so if the column
  // read ever stops finding them the test has to fail rather than pass
  // over an empty set.
  assert.deepEqual(
    polymorphic,
    ["audit_events", "evidence_extraction_runs"],
    "the column read must still find the two known polymorphic tables"
  );

  const unaccounted = polymorphic
    .filter((table) => !(RETENTION_SURFACES as readonly string[]).includes(table))
    .filter((table) => !POLYMORPHIC_ENTITY_EXEMPTIONS.some((exemption) => exemption.table === table));
  assert.deepEqual(
    unaccounted,
    [],
    "a table can name an application through entity_type/entity_id but is not in the retention plan. " +
      "No foreign key declares that association, so nothing else will catch it. Add it to " +
      "RETENTION_SURFACES, or exempt it with the entity types it writes."
  );

  for (const exemption of POLYMORPHIC_ENTITY_EXEMPTIONS) {
    assert.ok(
      polymorphic.includes(exemption.table),
      `${exemption.table} no longer carries the pair; remove the exemption (${exemption.reason})`
    );
  }
});

test("each polymorphic surface says in the plan that it keeps the identifier", async () => {
  // The classification is the thing that was wrong, not the membership.
  // audit_events was in RETENTION_SURFACES the whole time, under a
  // disposition that took it straight back out of the survivor list, so
  // a check that only asserted membership would have passed against the
  // defect.
  const { tableColumns } = await assertRetentionPurgeBlockers(databaseUrl());
  const plan = planRetention(
    { organizationId: "11111111-1111-4111-8111-111111111111", windowDays: 30 },
    new Date("2026-08-29T12:00:00.000Z")
  );
  for (const table of polymorphicTables(tableColumns)) {
    const surface = plan.surfaces.find((entry) => entry.surface === table);
    assert.ok(surface !== undefined, `${table} is not in the plan`);
    assert.match(
      surface.holds,
      /entity_id/u,
      `${table} carries entity_id but its holds does not name it, so the privacy notice built from ` +
        `this plan does not mention the identifier it keeps`
    );
    assert.ok(
      surface.disposition.startsWith("blocked"),
      `${table} is append-only and keeps an application identifier, so it cannot be dispositioned ` +
        `${surface.disposition}`
    );
  }
});

test("the identifier really cannot be deleted or blanked on either polymorphic surface", async () => {
  // Both directions, because a plan saying the identifier is retained
  // would be wrong in the other direction if an UPDATE could blank it:
  // retention would then be a one-line redaction job rather than a
  // schema decision, the same distinction the evidence quote turns on.
  const { failures } = await assertRetentionPurgeBlockers(databaseUrl());
  assert.match(failures["audit_events:delete"] ?? "", /append-only: DELETE is not allowed/);
  assert.match(failures["audit_events:redact"] ?? "", /append-only: UPDATE is not allowed/);
  assert.match(failures["evidence_extraction_runs:delete"] ?? "", /append-only: DELETE is not allowed/);
  assert.match(failures["evidence_extraction_runs:redact"] ?? "", /append-only: UPDATE is not allowed/);
});
