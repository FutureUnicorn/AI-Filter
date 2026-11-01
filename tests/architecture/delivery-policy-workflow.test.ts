import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

const workflow = read(".github/workflows/delivery-policy.yml");
const validator = read("scripts/ci/validate-delivery-metadata.mjs");
const ci = read(".github/workflows/ci.yml");
const rollout = read("docs/engineering/delivery-governance-rollout.md");
const metadataGuide = read("docs/engineering/delivery-metadata.md");

test("delivery metadata runs as an explicitly report-only pull_request check", () => {
  assert.match(workflow, /^name: Delivery Policy$/mu);
  assert.match(workflow, /^ {2}pull_request:$/mu);
  for (const event of [
    "opened",
    "reopened",
    "edited",
    "synchronize",
    "ready_for_review",
    "converted_to_draft"
  ]) {
    assert.ok(workflow.includes(event), `missing pull_request activity ${event}`);
  }
  assert.match(
    workflow,
    /branches: \[develop, main, "feature\/\*\*"\]/
  );
  assert.match(workflow, /Delivery Policy \/ PR Metadata \(Report Only\)/);
  assert.match(workflow, /--event "\$GITHUB_EVENT_PATH" --report-only/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /merge_group:/);
  assert.doesNotMatch(ci, /Delivery Policy \/ PR Metadata/);
});

test("the report-only workflow has no secret or write-capable path", () => {
  assert.match(workflow, /^permissions:\s*\n {2}contents: read$/mu);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /permissions:[\s\S]*?\bwrite\b/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.(?:body|title)/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
  assert.doesNotMatch(workflow, /\|\|\s*true/);

  const uses = [...workflow.matchAll(/^\s*uses:\s+[^@\s]+@([^\s#]+)/gmu)];
  assert.notEqual(uses.length, 0);
  for (const match of uses) {
    assert.match(match[1] ?? "", /^[0-9a-f]{40}$/);
  }
});

test("the validator treats event content as data and never invokes a shell", () => {
  assert.match(validator, /GITHUB_EVENT_PATH/);
  assert.match(validator, /JSON\.parse/);
  assert.match(validator, /Buffer\.byteLength/);
  assert.doesNotMatch(validator, /node:child_process/);
  assert.doesNotMatch(validator, /\b(?:execFile|execFileSync|execSync|spawn|spawnSync|eval)\s*\(/);
  assert.doesNotMatch(validator, /new Function/);
});

test("documentation keeps structural reporting separate from trusted enforcement", () => {
  for (const document of [rollout, metadataGuide]) {
    assert.match(document, /report[- ]only/i);
    assert.match(document, /does not verify|does not independently verify/i);
    assert.match(document, /not.*required|must not.*required/i);
  }
  assert.match(metadataGuide, /pull_request/);
  assert.match(metadataGuide, /merge_group/);
  assert.match(metadataGuide, /pull_request_target/);
});
