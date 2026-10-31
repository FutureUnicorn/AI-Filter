import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const policyVersion = "AF-DELIVERY-1.0";
const canonicalPolicy = "docs/engineering/delivery-workflow.md";

const wrappers = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/delivery-workflow.mdc",
  ".windsurf/rules/delivery-workflow.md"
] as const;

const skills = [
  "af-investigate-ticket",
  "af-implement-and-verify",
  "af-pr-handoff",
  "af-review-remediation",
  "af-jira-reconcile"
] as const;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("the canonical policy declares one version and preserves binding contracts", () => {
  const policy = read(canonicalPolicy);
  assert.match(policy, new RegExp(`Policy ID:\\*\\* ${policyVersion}`));
  assert.ok(policy.includes("docs/PRODUCT_BOUNDARY.md"));
  assert.ok(policy.includes("docs/engineering/ci.md"));
  assert.ok(policy.includes("apps/web/AGENTS.md"));
  assert.ok(policy.includes("feature-branch merge does not mean delivery to `develop`"));
  assert.ok(policy.includes("must not transition Jira"));
});

test("provider adapters stay thin and point to the canonical policy version", () => {
  for (const wrapper of wrappers) {
    const body = read(wrapper);
    assert.ok(body.includes(policyVersion), `${wrapper} lacks ${policyVersion}`);
    assert.ok(body.includes(canonicalPolicy), `${wrapper} does not reference ${canonicalPolicy}`);
    assert.ok(
      Buffer.byteLength(body, "utf8") < 2500,
      `${wrapper} duplicates too much policy instead of remaining a thin adapter`
    );
  }
});

test("repository skills have valid local contracts without private dependencies", () => {
  for (const skill of skills) {
    const relativePath = `.agents/skills/${skill}/SKILL.md`;
    const body = read(relativePath);
    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? "";
    assert.match(frontMatter, new RegExp(`^name:\\s*${skill}$`, "m"));
    assert.match(frontMatter, /^description:\s*\S.{20,}$/m);
    assert.ok(body.includes(policyVersion), `${relativePath} lacks policy version`);
    assert.ok(body.includes(canonicalPolicy), `${relativePath} lacks canonical policy`);
    assert.doesNotMatch(body, /~\/\.agents\/skills|\.codex\/skills|software-project-orchestrator|C:\\\\Users\\\\/i);
  }
});

test("project instructions do not depend on private user-level configuration", () => {
  const files = [
    ...wrappers,
    "CONTRIBUTING.md",
    canonicalPolicy,
    "docs/engineering/ai-assistant-support.md",
    ...skills.map((skill) => `.agents/skills/${skill}/SKILL.md`)
  ];
  for (const file of files) {
    assert.doesNotMatch(
      read(file),
      /~\/\.agents\/skills|\.codex\/skills|software-project-orchestrator|C:\\\\Users\\\\/i,
      `${file} refers to private user-level configuration`
    );
  }
});

test("the existing scoped Next.js agent contract remains present", () => {
  const scoped = read("apps/web/AGENTS.md");
  assert.ok(scoped.includes("<!-- BEGIN:nextjs-agent-rules -->"));
  assert.ok(scoped.includes("node_modules/next/dist/docs/"));
  assert.ok(scoped.includes("<!-- END:nextjs-agent-rules -->"));
});

test("the pull request template contains readable and structured delivery evidence", () => {
  const template = read(".github/pull_request_template.md");
  for (const heading of [
    "## Jira and outcome",
    "## Acceptance criteria",
    "## Dependencies",
    "## Verification",
    "## Security, product boundary, and operations",
    "## AI assistance and accountability",
    "## Jira ready-for-review handoff",
    "## Structured delivery metadata"
  ]) {
    assert.ok(template.includes(heading), `missing ${heading}`);
  }
  assert.ok(template.includes('"schemaVersion": "1.0"'));
  assert.ok(template.includes('"humanEvidenceOwner"'));
  assert.ok(template.includes('"readyEvidence"'));
  assert.ok(template.includes('"approvedExceptions"'));
  assert.ok(template.includes('State (Met / Unmet / Deferred / Not verified)'));
  assert.ok(!template.includes('Partial'));
});

test("rollout documentation does not claim enforcement before administration", () => {
  const rollout = read("docs/engineering/delivery-governance-rollout.md");
  const baseline = read("docs/engineering/delivery-governance-baseline.md");
  assert.ok(rollout.includes("explicit ruleset update"));
  assert.ok(rollout.includes("Keep Jira transitions human controlled"));
  assert.ok(baseline.includes("No Jira status, comment, link, sprint, GitHub ruleset"));
});
