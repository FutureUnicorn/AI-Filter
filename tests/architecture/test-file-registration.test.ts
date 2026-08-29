import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A registered test file that does not exist is silently ignored.
//
// Verified on the Node version this repo pins (v26.7.0):
//
//   node --test tests/integration/correction-attribution.test.ts \
//               tests/integration/does-not-exist.test.ts
//   ℹ tests 6   ℹ pass 6   ℹ fail 0      exit code 0
//
// No warning, no non-zero exit. So a typo in package.json, or a test
// file moved without updating the script, removes an entire suite from
// CI and the build stays green. That is the worst shape a CI gap can
// take: it looks like everything passed, and the thing that would have
// told you otherwise is the thing that vanished. This ticket's own file
// move hit it -- 6 tests ran nowhere and the check reported green.
//
// AF-22 has a `test-registration.test.ts` covering the other direction
// (a file on disk nobody registered). It has not propagated to this
// branch yet. When it arrives these two should be folded into one file;
// they are answering halves of the same question.

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts as Record<
  string,
  string
>;
const TEST_SCRIPTS = ["test:unit:ts", "test:integration", "test:architecture"] as const;

function registeredFiles(): readonly string[] {
  return TEST_SCRIPTS.flatMap((key) => (scripts[key] ?? "").split(/\s+/u)).filter((entry) =>
    entry.endsWith(".test.ts")
  );
}

test("every registered test file exists, so no suite can silently vanish from CI", () => {
  const missing = registeredFiles().filter((file) => !existsSync(join(repositoryRoot, file)));
  assert.deepEqual(missing, [], `registered but absent from disk: ${missing.join(", ")}`);
});

test("every test file on disk is registered, so no suite can silently never run", () => {
  const onDisk = ["unit", "integration", "architecture"].flatMap((directory) =>
    readdirSync(join(repositoryRoot, "tests", directory))
      .filter((entry) => entry.endsWith(".test.ts"))
      .map((entry) => `tests/${directory}/${entry}`)
  );
  const registered = new Set(registeredFiles());
  const unregistered = onDisk.filter((file) => !registered.has(file));
  assert.deepEqual(unregistered, [], `on disk but never run: ${unregistered.join(", ")}`);
});

test("no test file is registered twice, which would double-count a suite", () => {
  const files = registeredFiles();
  const duplicates = files.filter((file, index) => files.indexOf(file) !== index);
  assert.deepEqual([...new Set(duplicates)], [], `registered more than once: ${duplicates.join(", ")}`);
});
