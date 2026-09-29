import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// `pnpm test:unit:ts` does not build the workspace packages;
// `pnpm test:integration` runs `build:packages` first. So a unit test
// that reaches a module importing another package by its BARE specifier
// -- `@signal-audit/contracts` rather than a relative path -- runs only
// when someone happens to have built dist already.
//
// That is a worse failure than it sounds, because the local gate hides
// it. `pnpm check` runs typecheck before tests, typecheck builds dist,
// and by the time the unit suite runs the artifact it needs is there.
// CI's unit job starts cold and fails with ERR_MODULE_NOT_FOUND, and the
// person who added the import has a green local run saying otherwise.
//
// Found on AF-66: tests/unit/support-access.test.ts imported redactPii
// from packages/security/src, which imports @signal-audit/contracts and
// @signal-audit/domain. The fix is not to build more; it is to move the
// test to tests/integration, where the build has happened. The repo
// already states this rule in its notes, and it had nothing enforcing
// it.
//
// The walk follows relative imports only, which is exactly the point: a
// bare specifier is the thing being looked for, so following one would
// defeat the check.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const unitDirectory = join(repositoryRoot, "tests/unit");

/**
 * Unit tests allowed to reach a bare workspace specifier anyway.
 *
 * Empty, and each entry would have to say why the file cannot move to
 * tests/integration, which is nearly always where it belongs. The test
 * below fails on a stale entry, so this cannot quietly accumulate.
 */
const BUILD_DEPENDENT_UNIT_TESTS: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [];

const BARE_WORKSPACE_IMPORT = /["']@signal-audit\/[a-z-]+["']/u;
const RELATIVE_IMPORT = /\bfrom\s+["'](\.[^"']+)["']/gu;

/** Every relative source file a file reaches, transitively. */
function reachableSources(entry: string): readonly string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current) || !existsSync(current)) {
      continue;
    }
    seen.add(current);
    const source = readFileSync(current, "utf8");
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1];
      if (specifier === undefined) {
        continue;
      }
      queue.push(resolve(dirname(current), specifier));
    }
  }
  seen.delete(entry);
  return [...seen];
}

function unitTestFiles(): readonly string[] {
  return readdirSync(unitDirectory)
    .filter((file) => file.endsWith(".test.ts"))
    .sort();
}

test("no unit test reaches a module that imports a workspace package by name", () => {
  const offenders: string[] = [];
  for (const file of unitTestFiles()) {
    if (BUILD_DEPENDENT_UNIT_TESTS.some((exemption) => exemption.file === file)) {
      continue;
    }
    const entry = join(unitDirectory, file);
    for (const source of [entry, ...reachableSources(entry)]) {
      if (BARE_WORKSPACE_IMPORT.test(readFileSync(source, "utf8"))) {
        offenders.push(`${file} -> ${source.slice(repositoryRoot.length + 1)}`);
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a unit test reaches a module that imports @signal-audit/* by name, so it needs built dist and " +
      "CI's unit job -- which does not build -- fails on it from cold. Move the test to " +
      "tests/integration, where build:packages has run."
  );
});

test("the walk really does reach transitively, so the check cannot pass vacuously", () => {
  // The defect this guards was two hops out: the test imported
  // packages/security/src, and that file, not the test, held the bare
  // specifier. A checker that only read the test file would have passed.
  const security = join(repositoryRoot, "packages/security/src/index.ts");
  assert.ok(existsSync(security), "packages/security/src/index.ts must exist for this control");
  assert.match(
    readFileSync(security, "utf8"),
    BARE_WORKSPACE_IMPORT,
    "packages/security still has to be an example of the thing being detected"
  );
  const reached = reachableSources(join(repositoryRoot, "tests/integration/support-access-integrity.test.ts"));
  assert.ok(
    reached.includes(security),
    "the walk must reach packages/security/src from a test that imports it"
  );
});

test("every exemption is still needed, or it has to go", () => {
  for (const exemption of BUILD_DEPENDENT_UNIT_TESTS) {
    const entry = join(unitDirectory, exemption.file);
    assert.ok(existsSync(entry), `${exemption.file} no longer exists; remove the exemption`);
    const reaches = [entry, ...reachableSources(entry)].some((source) =>
      BARE_WORKSPACE_IMPORT.test(readFileSync(source, "utf8"))
    );
    assert.ok(reaches, `${exemption.file} no longer needs a build; remove the exemption (${exemption.reason})`);
  }
});
