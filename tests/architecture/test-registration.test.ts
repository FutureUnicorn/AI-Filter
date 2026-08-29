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

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const packageManifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
) as { scripts: Record<string, string> };

function listTestFiles(directory: string): readonly string[] {
  return fs
    .readdirSync(path.join(repositoryRoot, directory))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `${directory}/${name}`);
}

test("every tests/unit test file is registered in the test:unit:ts script", () => {
  const files = listTestFiles("tests/unit");
  assert.ok(files.length > 0, "expected at least one unit test file");
  for (const file of files) {
    assert.ok(
      packageManifest.scripts["test:unit:ts"].includes(file),
      `${file} exists under tests/unit but is not registered in package.json's test:unit:ts script -- it will never run in CI`
    );
  }
});

test("every tests/integration test file is registered in the test:integration script", () => {
  const files = listTestFiles("tests/integration");
  assert.ok(files.length > 0, "expected at least one integration test file");
  for (const file of files) {
    assert.ok(
      packageManifest.scripts["test:integration"].includes(file),
      `${file} exists under tests/integration but is not registered in package.json's test:integration script -- it will never run in CI`
    );
  }
});
