import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A registered test file that does not exist is silently ignored.
//
// Verified on the Node version this repo pins (v26.7.0):
//
//   node --test <a real file>.test.ts tests/integration/does-not-exist.test.ts
//   ℹ tests 6   ℹ pass 6   ℹ fail 0        exit code 0
//
// No warning, no non-zero exit, nothing on stderr. So a typo in
// package.json, or a test file moved without updating the script,
// removes an entire suite from CI and the build stays green. That is the
// worst shape a CI gap can take: it looks like everything passed, and
// the thing that would have said otherwise is the thing that vanished.
// AF-50 hit it -- a failed `git mv` left 6 tests running nowhere while
// `pnpm check` reported green.
//
// AF-22 has a `test-registration.test.ts` covering the same three
// directions, and it is the version that should survive. It is also 28
// merges below this branch: AF-22 -> AF-34 ... AF-44 -> AF-23 ... AF-33
// -> AF-45 -> ... Measured rather than assumed, and confirmed by
// merge-tree -- merging AF-33 into AF-45 does not bring the file,
// because AF-33 does not have it either. 21 of the 34 open pull requests
// have no registration guard in either direction.
//
// So this is a deliberate local copy, not a duplicate to reconcile now.
// Fold it into AF-22's version when that actually arrives; at that point
// the overlap will be visible in one diff, which is the right moment to
// resolve it.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts as Record<
  string,
  string
>;
const TEST_DIRECTORIES = ["unit", "integration", "architecture"] as const;
const TEST_SCRIPTS = ["test:unit:ts", "test:integration", "test:architecture"] as const;

function registeredFiles(): readonly string[] {
  // Matched against the real `tests/<dir>/<name>.test.ts` shape rather
  // than by substring, so a registration naming a different directory
  // cannot satisfy an assertion about this one by accident.
  const pattern = /^tests\/(?:unit|integration|architecture)\/[A-Za-z0-9._-]+\.test\.ts$/u;
  return TEST_SCRIPTS.flatMap((key) => (scripts[key] ?? "").split(/\s+/u)).filter((entry) => pattern.test(entry));
}

test("every registered test file exists, so no suite can silently vanish from CI", () => {
  const missing = registeredFiles().filter((file) => !existsSync(join(repositoryRoot, file)));
  assert.deepEqual(missing, [], `registered but absent from disk, so node --test skips it: ${missing.join(", ")}`);
});

test("every test file on disk is registered, so no suite can silently never run", () => {
  const onDisk = TEST_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(repositoryRoot, "tests", directory))
      .filter((entry) => entry.endsWith(".test.ts"))
      .map((entry) => `tests/${directory}/${entry}`)
  );
  const registered = new Set(registeredFiles());
  const unregistered = onDisk.filter((file) => !registered.has(file));
  assert.deepEqual(unregistered, [], `on disk but never run in CI: ${unregistered.join(", ")}`);
});

test("no test file is registered twice, which would double-count a suite", () => {
  // Both of us unioned these lists by hand during the stack cascades,
  // which is exactly how a file ends up listed twice.
  const files = registeredFiles();
  const duplicates = [...new Set(files.filter((file, index) => files.indexOf(file) !== index))];
  assert.deepEqual(duplicates, [], `listed more than once: ${duplicates.join(", ")}`);
});
