import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AF-22: test:unit:ts and test:integration list every file explicitly
// rather than globbing their directories, so a new test file that is
// only discoverable by `grep` silently never runs in CI. This closes
// that gap the same way workspace-structure.test.ts's "one pnpm
// lockfile" test guards a different silent-drift risk.
//
// An explicit list can drift in three directions, and all three are
// silent, so all three are checked here:
//
//   1. on disk, not registered  -- the file never runs.
//   2. registered, not on disk  -- `node --test` accepts a path that does
//      not exist, prints no warning, and exits 0. Verified on the pinned
//      v26.7.0: running one real file plus one missing file reports
//      "pass 4 / fail 0" and exit code 0. A renamed or moved file whose
//      registration was not updated therefore looks green while running
//      nothing, which is strictly worse than direction 1 because the
//      suite appears to be covering something.
//   3. registered twice        -- harmless to correctness but it means a
//      merge unioned two lists carelessly, and it inflates the counts
//      that make direction 2 hard to notice by eye.

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const packageManifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
) as { scripts: Record<string, string> };

const SUITES = [
  { directory: "tests/unit", script: "test:unit:ts" },
  { directory: "tests/integration", script: "test:integration" },
  { directory: "tests/architecture", script: "test:architecture" }
] as const;

function listTestFiles(directory: string): readonly string[] {
  return fs
    .readdirSync(path.join(repositoryRoot, directory))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `${directory}/${name}`)
    .sort();
}

/** Paths the script actually passes to `node --test`, for one directory. */
function registeredFiles(script: string, directory: string): readonly string[] {
  const command = packageManifest.scripts[script] ?? "";
  const pattern = new RegExp(`${directory}/[A-Za-z0-9._-]+\\.test\\.ts`, "g");
  return command.match(pattern) ?? [];
}

for (const { directory, script } of SUITES) {
  test(`every ${directory} file is registered in ${script}`, () => {
    const files = listTestFiles(directory);
    assert.ok(files.length > 0, `expected at least one test file under ${directory}`);
    const registered = new Set(registeredFiles(script, directory));
    for (const file of files) {
      assert.ok(
        registered.has(file),
        `${file} exists under ${directory} but is not registered in package.json's ${script} script -- it will never run in CI`
      );
    }
  });

  test(`every file registered in ${script} exists on disk`, () => {
    const onDisk = new Set(listTestFiles(directory));
    for (const file of registeredFiles(script, directory)) {
      assert.ok(
        onDisk.has(file),
        `${script} registers ${file}, which does not exist. node --test skips a missing path without warning and still exits 0, ` +
          `so this suite would report success while running nothing for that file`
      );
    }
  });

  test(`${script} registers each file exactly once`, () => {
    const registered = registeredFiles(script, directory);
    const seen = new Set<string>();
    const duplicated = registered.filter((file) => (seen.has(file) ? true : (seen.add(file), false)));
    assert.deepEqual(
      duplicated,
      [],
      `${script} lists these files more than once: ${duplicated.join(", ")} -- usually a merge that unioned two lists without de-duplicating`
    );
  });
}
