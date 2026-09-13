import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_DIR = path.join(repositoryRoot, "packages", "db", "migrations");

/**
 * The migration runner applies `*.sql` in filename order with no manifest,
 * so the numeric prefix is the only thing deciding execution order.
 *
 * Two files sharing a prefix make that order depend on the rest of the
 * filename, which is how a real hazard reached this reconstruction: AF-29
 * shipped `0013_file_intake_validation.sql` while `0013_file_intakes.sql`
 * already existed, and because `_` sorts before `s` the ALTER TABLE would
 * have run before the CREATE TABLE it depends on. Nothing in the repository
 * would have caught that; the replay only caught it because the collision
 * was inspected by hand.
 *
 * Grandfathering rather than renaming: `0006` and `0009` were already
 * duplicated on the baseline. Renumbering a migration that may already have
 * been applied somewhere rewrites history for those deployments, so the
 * existing pairs are recorded as known exceptions and everything new is held
 * to the invariant. Shrinking this list is safe; growing it is the thing this
 * test exists to prevent.
 */
const GRANDFATHERED_DUPLICATE_PREFIXES: ReadonlySet<string> = new Set(["0006", "0009"]);

function migrationFilenames(): readonly string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function migrationPrefixes(): readonly string[] {
  return migrationFilenames().map((name) => {
    const prefix = /^(\d+)_/u.exec(name)?.[1];
    assert.ok(prefix !== undefined, `migration ${name} must start with a numeric prefix`);
    return prefix;
  });
}

test("no new migration reuses a numeric prefix", () => {
  const byPrefix = new Map<string, string[]>();
  for (const name of migrationFilenames()) {
    const prefix = /^(\d+)_/u.exec(name)?.[1];
    assert.ok(prefix !== undefined, `migration ${name} must start with a numeric prefix`);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }

  const offenders = [...byPrefix.entries()]
    .filter(([prefix, names]) => names.length > 1 && !GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix))
    .map(([prefix, names]) => `${prefix}: ${names.join(", ")}`);

  assert.deepEqual(
    offenders,
    [],
    `migration prefixes must be unique so execution order does not depend on the rest of the filename:\n${offenders.join("\n")}`
  );
});

test("every grandfathered duplicate still exists, so the exemption list cannot rot", () => {
  const present = new Set(migrationPrefixes());
  for (const prefix of GRANDFATHERED_DUPLICATE_PREFIXES) {
    assert.ok(
      present.has(prefix),
      `prefix ${prefix} is exempted but no migration uses it; remove it from the exemption list`
    );
  }
  // An exemption that no longer covers a real duplicate is dead weight that
  // would silently permit a future collision on that number.
  const counts = new Map<string, number>();
  for (const prefix of migrationPrefixes()) {
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  for (const prefix of GRANDFATHERED_DUPLICATE_PREFIXES) {
    assert.ok(
      (counts.get(prefix) ?? 0) > 1,
      `prefix ${prefix} is exempted as a duplicate but is no longer duplicated; remove the exemption`
    );
  }
});

test("migration filename order matches numeric order", () => {
  // Filename sort and numeric sort agree only while prefixes are
  // zero-padded to the same width. A future `010_` next to `0100_` would
  // reorder silently, so the width is pinned rather than assumed.
  const widths = new Set(migrationPrefixes().map((prefix) => prefix.length));
  assert.deepEqual(
    [...widths],
    [4],
    `every migration prefix must be 4 digits or filename order stops matching numeric order, got widths: ${[...widths].join(", ")}`
  );
});

/**
 * A migration referenced by name in source is a dependency the compiler cannot
 * see. Renumbering during this reconstruction silently broke two of them:
 * `assertApplicationQueueTenantIsolation` still loaded `0012_file_intakes.sql`
 * after that file became `0013_`, and the failure only surfaced as an ENOENT
 * deep inside a probe at test time, not at build time.
 *
 * Scans source rather than a hand-kept list, so a new hard-coded reference is
 * covered the moment it is written.
 */
test("every migration filename hard-coded in source exists on disk", () => {
  const roots = ["packages", "apps", "scripts", "tests"];
  const offenders: string[] = [];
  const onDisk = new Set(migrationFilenames());

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") {
          continue;
        }
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js)$/u.test(entry.name)) {
        continue;
      }
      // Comment lines are skipped: a migration named in prose (including the
      // history recorded above) documents what a file used to be called and is
      // not a dependency the code resolves. Only a live string literal is.
      const lines = fs.readFileSync(full, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          continue;
        }
        for (const match of line.matchAll(/["'`](\d{4}_[a-z0-9_]+\.sql)["'`]/gu)) {
          const name = match[1];
          if (name !== undefined && !onDisk.has(name)) {
            offenders.push(`${path.relative(repositoryRoot, full)} references ${name}`);
          }
        }
      }
    }
  };
  for (const root of roots) {
    const full = path.join(repositoryRoot, root);
    if (fs.existsSync(full)) {
      walk(full);
    }
  }

  assert.deepEqual(
    [...new Set(offenders)],
    [],
    `source references migrations that do not exist:\n${[...new Set(offenders)].join("\n")}`
  );
});
