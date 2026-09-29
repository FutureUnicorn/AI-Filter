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

const workflowsDirectory = path.join(repositoryRoot, ".github", "workflows");
const workflows = fs
  .readdirSync(workflowsDirectory)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({
    name,
    text: fs.readFileSync(path.join(workflowsDirectory, name), "utf8")
  }));

/**
 * A workflow can reach the production Compose project if it runs on the
 * production runner, drives the production environment CLI, or deploys
 * through the `production` GitHub environment. Any one of those is enough
 * to touch `signal_audit_production` and replay its migrations.
 */
function reachesProduction(workflow: string): boolean {
  return (
    workflow.includes("signal-audit-production") ||
    /cli\.mjs\s+production/u.test(workflow) ||
    /^\s*environment:\s*\n\s+name:\s*production\s*$/mu.test(workflow)
  );
}

/**
 * The concurrency block declared at workflow level, if any. Anchored to column
 * zero on purpose: the same block nested under a job covers only that job, so
 * a second job in the same run could still deploy outside the group.
 */
function topLevelConcurrency(workflow: string): string | undefined {
  return /^concurrency:\n((?:[ \t]+\S.*\n)+)/mu.exec(workflow)?.[1];
}

function assertSerialisesProduction(concurrency: string | undefined, source: string): void {
  assert.notEqual(
    concurrency,
    undefined,
    `${source} must declare a top-level concurrency block`
  );
  assert.match(
    concurrency ?? "",
    /^\s+group: production\s*$/mu,
    `${source} must join the constant production group`
  );
  assert.doesNotMatch(
    concurrency ?? "",
    /\$\{\{/u,
    `${source}: the group must be a constant -- an expression makes it per-revision, which serialises nothing`
  );
  // False would let a newer revision cancel a deployment mid-migration.
  assert.match(
    concurrency ?? "",
    /^\s+cancel-in-progress: false\s*$/mu,
    `${source} must not cancel an in-flight production deployment`
  );
}

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

test("CI targets both protected branches and stacked feature branches with read-only, secret-free validation", () => {
  // AF-92: `pull_request.branches` matches a PR's BASE branch. Every PR
  // stacked on a feature branch (rather than develop/main directly) has a
  // feature-branch base, so without this pattern no run was ever queued for
  // it -- confirmed live on ~30 open PRs, including AF-19's own suite and
  // the RLS tenant-isolation probes, silent for hours with nobody able to
  // see it. `push.branches` gets the same pattern so a direct push to a
  // feature branch (not just a PR into one) is validated too.
  assert.match(ci, /pull_request:\s*\n\s+branches: \[develop, main, "feature\/\*\*"\]/);
  assert.match(ci, /push:\s*\n\s+branches: \[develop, main, "feature\/\*\*"\]/);
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
  const eligibilitySection = productionGate.split(/\n {2}deploy:/u)[0] ?? productionGate;
  assert.equal(eligibilitySection.includes("secrets."), false);
  assert.match(productionGate, /needs: eligibility/u);
  assert.match(productionGate, /environment:\s+name: production/u);
  assert.match(productionGate, /secrets\.POSTGRES_PASSWORD/u);
});

test("production deployments are serialised across revisions, not per revision", () => {
  // AF-95. Every production run must land in one concurrency group whatever
  // revision triggered it, so two green pushes to main cannot deploy at once
  // against the same volume and replay migrations concurrently. Keying the
  // group on head_sha gives each push its own group and serialises nothing;
  // that the single signal-audit-production runner currently hides this is
  // infrastructure, not a property of this repository.
  assertSerialisesProduction(topLevelConcurrency(productionGate), "production-gate.yml");
});

test("every workflow that can reach production joins that same group", () => {
  // Review REV-001 on AF-95: the assertion above pins the text of one file,
  // which is a weaker claim than the guarantee. Concurrency groups are
  // repository-wide, so "only one thing deploys production at a time" holds
  // only if every workflow able to touch the production Compose project joins
  // group `production`. A second deploying workflow with no concurrency block
  // at all would satisfy the per-file assertion and break the guarantee --
  // and production-gate.yml itself records that AF-11's real deployment job
  // is still to be added.
  const productionWorkflows = workflows.filter((workflow) => reachesProduction(workflow.text));

  // Without this the loop below passes vacuously if the detection above ever
  // stops recognising a production workflow.
  assert.equal(
    productionWorkflows.some((workflow) => workflow.name === "production-gate.yml"),
    true,
    "production-gate.yml must be detected as production-reaching, or this test proves nothing"
  );

  for (const workflow of productionWorkflows) {
    assertSerialisesProduction(topLevelConcurrency(workflow.text), workflow.name);
  }
});
