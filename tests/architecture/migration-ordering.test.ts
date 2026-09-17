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
 * Two exemptions, with different histories, corrected after the PR #83 review
 * pointed out this comment was wrong:
 *
 *   - `0006` was already duplicated on the reconstruction baseline. `git
 *     ls-tree` on the merge base shows both `0006` files on develop.
 *   - `0009` was NOT. The baseline had one `0009` file; 0009_roles.sql arrives
 *     with this reconstruction, so this branch creates that collision and then
 *     exempts it, which is the thing the paragraph below says to prevent.
 *
 * It is kept rather than renumbered because there is no free integer between
 * `0009` and `0011`: roles has to be applied before 0011_rubrics.sql, which
 * references it, so moving it means renumbering the whole tail. That is what
 * produced nineteen wrong migration references the last time, and the exemption
 * is only tolerable because the check below proves this particular collision
 * cannot break anything.
 *
 * Renumbering a migration that may already have been applied somewhere also
 * rewrites history for those deployments. Shrinking this list is safe; growing
 * it needs the same proof.
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

const SOURCE_ROOTS = ["packages", "apps", "scripts", "tests"] as const;

/**
 * The one file whose comments deliberately name migrations that no longer
 * exist, because its whole subject is what they used to be called.
 *
 * Scoped to a single path rather than a pattern, so a second file cannot start
 * quietly accumulating stale names under the same excuse, and asserted below
 * to actually still contain such a reference so the exemption cannot rot.
 */
const MIGRATION_HISTORY_FILE = path.join("tests", "architecture", "migration-ordering.test.ts");

interface CommentLine {
  readonly relative: string;
  readonly number: number;
  readonly text: string;
}

function commentLines(): readonly CommentLine[] {
  const collected: CommentLine[] = [];
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
      const relative = path.relative(repositoryRoot, full);
      fs.readFileSync(full, "utf8")
        .split("\n")
        .forEach((text, index) => {
          const trimmed = text.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
            collected.push({ relative, number: index + 1, text });
          }
        });
    }
  };
  for (const root of SOURCE_ROOTS) {
    const full = path.join(repositoryRoot, root);
    if (fs.existsSync(full)) {
      walk(full);
    }
  }
  return collected;
}

function namedMigrationFiles(text: string): readonly string[] {
  return [...text.matchAll(/\b(\d{4}_[a-z0-9_]+\.sql)\b/gu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * PR #83 review: `deriveCandidateWorkflowStatus` attributed the single-head
 * invariant to prefix `0019`, which is correction_attribution and has nothing to
 * do with decisions. Eighteen further references turned out to be wrong the
 * same way once swept for, all from one cause: the reconstruction renumbered
 * nine migrations and the remapper only rewrote path-qualified references, so
 * every bare number silently came to point at whatever now occupies it.
 *
 * The check above skips comments, on the grounds that prose is not a
 * dependency the code resolves. True, and beside the point: a wrong reference
 * sends whoever is debugging that invariant to a file that does not contain
 * it, which is the cost the reviewer actually named.
 *
 * So comments are held to the same standard, and the convention that makes
 * that possible is: name the file, not the number. A filename breaks visibly
 * when it stops existing. A bare prefix just starts meaning something else.
 */
test("every migration filename named in a comment exists on disk", () => {
  const onDisk = new Set(migrationFilenames());
  const offenders = commentLines()
    .filter((line) => line.relative !== MIGRATION_HISTORY_FILE)
    .flatMap((line) =>
      namedMigrationFiles(line.text)
        .filter((name) => !onDisk.has(name))
        .map((name) => `${line.relative}:${line.number} names ${name}`)
    );

  assert.deepEqual(
    [...new Set(offenders)],
    [],
    `comments name migrations that do not exist:\n${[...new Set(offenders)].join("\n")}`
  );
});

test("the migration-history exemption still covers a real historical reference", () => {
  const onDisk = new Set(migrationFilenames());
  const historical = commentLines()
    .filter((line) => line.relative === MIGRATION_HISTORY_FILE)
    .flatMap((line) => namedMigrationFiles(line.text))
    .filter((name) => !onDisk.has(name));

  assert.ok(
    historical.length > 0,
    `${MIGRATION_HISTORY_FILE} no longer names any renamed migration, so its exemption is dead weight; remove it`
  );
});

/**
 * The other half of "name the file, not the number". A bare prefix in prose is
 * unbindable: nothing can check it, and a renumber cannot break it visibly.
 *
 * Backticks are the escape hatch, for prose genuinely discussing a number as a
 * number -- which prefix a migration was authored under before renumbering, or
 * which prefixes collide. Substituting a filename there would say something
 * different, so those are exempt by how they are written rather than by being
 * listed somewhere this test would have to keep in sync.
 */
test("comments reference migrations by filename, never by bare number", () => {
  const prefixes = new Set(migrationPrefixes());
  const offenders = commentLines().flatMap((line) => {
    // Filenames and backticked spans are removed first, so neither
    // 0011_rubrics.sql nor `0011` still looks like a bare number.
    const stripped = line.text.replace(/\d{4}_[a-z0-9_]+\.sql/gu, "").replace(/`[^`]*`/gu, "");
    return [...stripped.matchAll(/\b(\d{4})\b/gu)]
      .map((match) => match[1])
      .filter((prefix): prefix is string => prefix !== undefined && prefixes.has(prefix))
      .map((prefix) => `${line.relative}:${line.number} says ${prefix} -- ${line.text.trim()}`);
  });

  assert.deepEqual(
    [...new Set(offenders)],
    [],
    "these comments reference a migration by bare number, which cannot be checked and does not survive a " +
      `renumber. Name the file, or backtick the number if the numbering itself is the point:\n${[
        ...new Set(offenders)
      ].join("\n")}`
  );
});

/**
 * The exemptions above are only safe if the colliding files can be applied in
 * either order, and until now that was a claim in a comment rather than a
 * checked property.
 *
 * Two migrations sharing a prefix are order-independent when they touch
 * disjoint sets of tables: filename sort decides which runs first, and neither
 * can care. When they touch the same table, the sort order becomes
 * load-bearing and nothing pins it. That is exactly the shape of the real
 * hazard this reconstruction hit, where `0013_file_intake_validation.sql` and
 * `0013_file_intakes.sql` both touched file_intakes and `_` sorting before `s`
 * put the ALTER TABLE ahead of the CREATE TABLE. This check would have caught
 * it; the prose claim did not.
 */
function tablesTouched(sql: string): ReadonlySet<string> {
  const patterns = [
    /CREATE TABLE(?: IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/giu,
    /ALTER TABLE\s+"?([a-z_][a-z0-9_]*)"?/giu,
    /CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)?\s+\S+\s+ON\s+"?([a-z_][a-z0-9_]*)"?/giu,
    /CREATE (?:CONSTRAINT )?TRIGGER\s+\S+\s+(?:BEFORE|AFTER|INSTEAD OF)[\s\S]*?\bON\s+"?([a-z_][a-z0-9_]*)"?/giu
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) {
        found.add(name.toLowerCase());
      }
    }
  }
  return found;
}

test("migrations sharing a prefix touch disjoint tables, so their order cannot matter", () => {
  const byPrefix = new Map<string, string[]>();
  for (const name of migrationFilenames()) {
    const prefix = /^(\d+)_/u.exec(name)?.[1];
    assert.ok(prefix !== undefined, `migration ${name} must start with a numeric prefix`);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }

  const duplicated = [...byPrefix.entries()].filter(([, names]) => names.length > 1);
  // If this ever reaches zero the duplicates were resolved and both this test
  // and the exemption list should go, rather than sitting here passing
  // vacuously.
  assert.ok(duplicated.length > 0, "no duplicated prefixes remain; remove this test and the exemption list");

  const offenders: string[] = [];
  for (const [prefix, names] of duplicated) {
    const touched = names.map(
      (name) => [name, tablesTouched(fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"))] as const
    );
    for (let i = 0; i < touched.length; i += 1) {
      for (let j = i + 1; j < touched.length; j += 1) {
        const [nameA, tablesA] = touched[i] ?? ["", new Set<string>()];
        const [nameB, tablesB] = touched[j] ?? ["", new Set<string>()];
        const shared = [...tablesA].filter((table) => tablesB.has(table));
        if (shared.length > 0) {
          offenders.push(`${prefix}: ${nameA} and ${nameB} both touch ${shared.join(", ")}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these same-prefix migrations touch the same tables, so which one runs first is decided by the rest of the " +
      `filename and nothing pins it:\n${offenders.join("\n")}`
  );
});
