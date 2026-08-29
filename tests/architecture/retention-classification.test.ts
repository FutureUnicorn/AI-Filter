import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyRetentionTable } from "../../packages/domain/src/index.ts";

// AF-66 added two tables. AF-63 would have caught them at runtime if I
// had forgotten to classify them -- but only after a database existed, a
// scheduled job ran, and somebody read the report. This makes the same
// omission fail while the person adding the table is still holding it.

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../packages/db/migrations");

function tablesCreatedByMigrations(): readonly string[] {
  const tables = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const match of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z0-9_]+)/gi)) {
      const table = match[1];
      if (table !== undefined) {
        tables.add(table);
      }
    }
  }
  return [...tables].sort();
}

test("the migrations really do create tables, so this suite cannot pass vacuously", () => {
  // Without this, a regex that stopped matching would make every
  // assertion below trivially true.
  const tables = tablesCreatedByMigrations();
  assert.ok(tables.length >= 20, `expected the schema to have many tables, found ${tables.length}`);
  assert.ok(tables.includes("applications"));
  assert.ok(tables.includes("evidence_outcomes"));
});

test("every table any migration creates is classified by the retention plan", () => {
  // The omission this guards against is not malice, it is a migration
  // written on a Friday. An unclassified table holding candidate text is
  // invisible to retention, to reconciliation and to the privacy notice
  // written from them.
  const unclassified = tablesCreatedByMigrations().filter(
    (table) => classifyRetentionTable(table) === "unclassified"
  );
  assert.deepEqual(
    unclassified,
    [],
    `these tables are not accounted for by the retention plan: ${unclassified.join(", ")}. ` +
      "Add each to RETENTION_SURFACES with a disposition, or to the exempt list with a reason."
  );
});

test("AF-66's own tables are classified, which is the case that prompted this suite", () => {
  assert.equal(classifyRetentionTable("support_access_grants"), "exempt");
  assert.equal(classifyRetentionTable("support_access_events"), "exempt");
});

test("a table nobody has classified reports as unclassified", () => {
  // The negative control, permanently: if classifyRetentionTable ever
  // returned "exempt" by default, every assertion above would pass while
  // meaning nothing.
  assert.equal(classifyRetentionTable("recruiter_scratch_notes"), "unclassified");
});
