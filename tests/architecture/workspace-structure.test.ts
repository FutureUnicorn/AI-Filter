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
  ["packages/config", "@signal-audit/config"],
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

// packages/security must not depend on packages/config (see
// dependency-cruiser.config.cjs), so the set of environments allowed to use
// the local console magic-link sender is declared in both. That duplication
// is deliberate, but it is only safe if the two cannot drift: review (#28)
// was caused by exactly one list being narrower than the other's intent.
// This asserts they stay identical, so adding a hosted environment to one
// without the other fails here rather than in a preview deployment.
test("the local-console environment lists in config and security are identical", async () => {
  const [config, security] = await Promise.all([
    import("../../packages/config/src/index.ts"),
    import("../../packages/security/src/index.ts")
  ]);
  const fromConfig = [...config.LOCAL_CONSOLE_ENVIRONMENTS].sort();
  // security keeps a Set privately; isHostedEnvironment is the observable
  // contract, so derive the list through it across every real environment.
  const fromSecurity = config.APP_ENVIRONMENTS.filter(
    (appEnv) => !security.isHostedEnvironment(appEnv)
  ).sort();
  assert.deepEqual(
    fromSecurity,
    fromConfig,
    "packages/security's console-allowed environments must match packages/config's LOCAL_CONSOLE_ENVIRONMENTS"
  );
  // And pin the intent itself, so widening both at once still gets noticed.
  assert.deepEqual(fromConfig, ["development", "test"]);
  for (const appEnv of ["preview", "staging", "production"] as const) {
    assert.equal(config.isHostedEnvironment(appEnv), true, `${appEnv} must be hosted`);
    assert.equal(security.isHostedEnvironment(appEnv), true, `${appEnv} must be hosted`);
  }
});
