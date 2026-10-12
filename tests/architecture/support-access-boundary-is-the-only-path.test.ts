import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AF-66, PR #72 REV-001. The finding was that `authorizeSupportAccess`
// and `support_access_events` were both correct and neither was
// reachable from production: the decision had no caller, the table had
// no writer, and the AF-66 guarantee rested on every future
// support-facing read remembering to authorize, log and read in that
// order.
//
// `readTenantDataUnderSupportAccess` is that order. This suite is what
// stops a second, shorter path appearing beside it. The realistic
// regression is not that someone deletes the boundary; it is that
// someone in a hurry writes the three statements inline, gets a
// working feature, and quietly reintroduces a read that can outlive
// its grant or go unlogged.
//
// Two rules, both mechanical:
//
//   1. Only the boundary writes `support_access_events`. A second
//      writer means a second path, by definition.
//   2. Only the boundary reads `support_access_grants` for an
//      authorization decision. Reading a grant anywhere else is how a
//      caller talks itself into a decision the boundary would have
//      made differently.
//
// Probes and fixtures are exempt, because proving a constraint means
// violating it on purpose. They are named individually rather than
// matched by a pattern, so a new probe is a deliberate addition to this
// list and not something a filename happens to slip past.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The only function permitted to write an event or authorize from a grant. */
const BOUNDARY = "readTenantDataUnderSupportAccess";

/**
 * Functions in packages/db that touch these tables while proving
 * something about them rather than serving a request. Keyed by function
 * name; the value says what it proves.
 */
const PROBES: Readonly<Record<string, string>> = {
  assertSupportAccessIntegrity: "proves the schema's own constraints reject what they claim to",
  assertSupportAccessBoundary: "proves every step of the boundary is load-bearing",
  createSupportAccessGrant: "issues a grant; it authorizes nothing and reads no tenant data",
  revokeSupportAccessGrant: "ends a grant; it authorizes nothing and reads no tenant data",
  // AF-61's retention probe. support_access_events is a retention
  // surface because the EVENT names the application the operator
  // opened, so the probe has to seed one to prove the purge reaches it.
  // Seeding a row is not serving a read, and no tenant data leaves this
  // function.
  assertRetentionPurgeBlockers: "seeds a support access event so the retention purge can be proven to reach it"
};

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next") {
        continue;
      }
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx|mjs|js)$/u.test(entry)) {
        found.push(full);
      }
    }
  };
  walk(directory);
  return found;
}

/**
 * Which top-level function a line sits inside. Relies on the repository's
 * existing convention that exported functions start at column zero and
 * close with a lone `}`, which `tests/architecture` already depends on
 * elsewhere.
 */
function enclosingFunctions(source: string): (lineIndex: number) => string {
  const lines = source.split("\n");
  const owners: string[] = [];
  let current = "(file scope)";
  for (const line of lines) {
    const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/u.exec(line);
    if (declaration?.[1] !== undefined) {
      current = declaration[1];
    }
    owners.push(current);
  }
  return (lineIndex: number): string => owners[lineIndex] ?? "(file scope)";
}

test("only the support-access boundary writes support_access_events", () => {
  const offenders: string[] = [];
  for (const file of [...sourceFiles(join(repositoryRoot, "packages")), ...sourceFiles(join(repositoryRoot, "apps"))]) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("support_access_events")) {
      continue;
    }
    const ownerAt = enclosingFunctions(source);
    source.split("\n").forEach((line, index) => {
      if (!/INSERT\s+INTO[^\n]*support_access_events/iu.test(line)) {
        return;
      }
      const owner = ownerAt(index);
      if (owner === BOUNDARY || owner in PROBES) {
        return;
      }
      offenders.push(`${relative(repositoryRoot, file)}:${index + 1} inside ${owner}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `support_access_events is written outside ${BOUNDARY}. Every write is an operator access, and an access ` +
      `logged by a path that did not also authorize and lock the grant is a log entry nobody can stand behind. ` +
      `Route the read through ${BOUNDARY}, or add the function to PROBES with what it proves:\n` +
      offenders.join("\n")
  );
});

test("only the support-access boundary reads support_access_grants", () => {
  const offenders: string[] = [];
  for (const file of [...sourceFiles(join(repositoryRoot, "packages")), ...sourceFiles(join(repositoryRoot, "apps"))]) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("support_access_grants")) {
      continue;
    }
    const ownerAt = enclosingFunctions(source);
    source.split("\n").forEach((line, index) => {
      if (!/\bFROM[^\n]*support_access_grants/iu.test(line)) {
        return;
      }
      const owner = ownerAt(index);
      if (owner === BOUNDARY || owner in PROBES) {
        return;
      }
      offenders.push(`${relative(repositoryRoot, file)}:${index + 1} inside ${owner}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `support_access_grants is read outside ${BOUNDARY}. A grant read anywhere else is an authorization decision ` +
      `made where nothing locks the row or writes the event:\n` + offenders.join("\n")
  );
});

test("the exemption list names only functions that still exist", () => {
  const dbSource = readFileSync(join(repositoryRoot, "packages/db/src/index.ts"), "utf8");
  const stale = Object.keys(PROBES).filter(
    (name) => !new RegExp(`function\\s+${name}\\b`, "u").test(dbSource)
  );
  assert.deepEqual(
    stale,
    [],
    `PROBES names functions that no longer exist, so the list has outlived what it excused. ` +
      `Self-expiring on purpose: delete these entries.\n${stale.join("\n")}`
  );
});
