import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const ciPath = path.join(repositoryRoot, ".github", "workflows", "ci.yml");
const productionGatePath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "production-gate.yml"
);

const ci = fs.readFileSync(ciPath, "utf8");
const productionGate = fs.readFileSync(productionGatePath, "utf8");

test("CI exposes every AF-12 check and a fail-closed aggregate gate", () => {
  for (const job of [
    "lint",
    "typecheck",
    "unit",
    "integration",
    "architecture",
    "build",
    "ci-required"
  ]) {
    assert.match(ci, new RegExp(`^  ${job}:`, "m"), `${job} job must exist`);
  }

  for (const command of [
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test:unit",
    "pnpm test:integration",
    "pnpm check:architecture",
    "pnpm build"
  ]) {
    assert.equal(ci.includes(`run: ${command}`), true, `${command} must run in CI`);
  }

  assert.match(ci, /name: CI \/ Required/);
  assert.match(ci, /if: always\(\)/);
  assert.match(ci, /if \[ "\$result" != "success" \]; then/);
});

test("CI targets both protected branches with read-only, secret-free validation", () => {
  assert.match(ci, /pull_request:\s*\n\s+branches: \[develop, main\]/);
  assert.match(ci, /push:\s*\n\s+branches: \[develop, main\]/);
  assert.match(ci, /merge_group:\s*\n\s+types: \[checks_requested\]/);
  assert.match(ci, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(ci, /continue-on-error:\s*true/);
  assert.equal(ci.includes("|| true"), false);
  assert.equal(ci.includes("secrets."), false);
});

test("workflow actions use immutable commit SHAs", () => {
  for (const workflow of [ci, productionGate]) {
    const uses = [...workflow.matchAll(/^\s*uses:\s+[^@\s]+@([^\s#]+)/gm)];
    assert.notEqual(uses.length, 0, "workflow must use at least one action");
    for (const match of uses) {
      assert.match(match[1] ?? "", /^[0-9a-f]{40}$/);
    }
  }
});

test("production eligibility is success-only and tied to the tested main SHA", () => {
  assert.match(productionGate, /workflow_run:/);
  assert.match(productionGate, /workflows: \["CI"\]/);
  assert.match(productionGate, /branches: \[main\]/);
  assert.match(productionGate, /workflow_run\.conclusion == 'success'/);
  assert.match(productionGate, /workflow_run\.event == 'push'/);
  assert.match(productionGate, /workflow_run\.head_branch == 'main'/);
  assert.match(productionGate, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(productionGate, /TESTED_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.equal(productionGate.includes("workflow_dispatch"), false);
  assert.equal(productionGate.includes("secrets."), false);
});
