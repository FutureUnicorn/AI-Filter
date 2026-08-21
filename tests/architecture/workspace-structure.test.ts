import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const expectedWorkspaces = new Map([
  ["apps/web", "@signal-audit/web"],
  ["apps/worker", "@signal-audit/worker"],
  ["packages/domain", "@signal-audit/domain"],
  ["packages/contracts", "@signal-audit/contracts"],
  ["packages/db", "@signal-audit/db"],
  ["packages/ai", "@signal-audit/ai"],
  ["packages/ingestion", "@signal-audit/ingestion"],
  ["packages/security", "@signal-audit/security"]
]);

test("AF-10 workspace areas exist with unique package names", () => {
  const names = new Set<string>();

  for (const [workspace, expectedName] of expectedWorkspaces) {
    const manifestPath = path.join(repositoryRoot, workspace, "package.json");
    assert.equal(fs.existsSync(manifestPath), true, `${workspace} must exist`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      name?: string;
      private?: boolean;
    };
    assert.equal(manifest.name, expectedName);
    assert.equal(manifest.private, true);
    assert.equal(names.has(expectedName), false, `${expectedName} must be unique`);
    names.add(expectedName);

    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, workspace, "tsconfig.json"), "utf8")
    ) as { extends?: string };
    assert.equal(tsconfig.extends, "../../tsconfig.base.json");
  }
});

test("test and eval concerns remain separate", () => {
  for (const directory of [
    "tests/architecture",
    "tests/integration",
    "tests/fixtures",
    "evals/cases",
    "evals/datasets"
  ]) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, directory)),
      true,
      `${directory} must exist`
    );
  }
});

test("one pnpm lockfile is authoritative", () => {
  const lockfiles: string[] = [];

  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (
        [
          ".cache",
          ".git",
          ".next",
          ".pytest_cache",
          ".venv",
          "__pycache__",
          "dist",
          "node_modules"
        ].includes(entry.name)
      ) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.name === "pnpm-lock.yaml") {
        lockfiles.push(absolutePath);
      }
    }
  }

  visit(repositoryRoot);
  assert.deepEqual(lockfiles, [path.join(repositoryRoot, "pnpm-lock.yaml")]);
});
