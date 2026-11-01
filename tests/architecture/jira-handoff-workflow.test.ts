import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow=fs.readFileSync(".github/workflows/jira-handoff.yml","utf8");
const verifier=fs.readFileSync("scripts/ci/verify-jira-handoff.mjs","utf8");
const readyWorkflow=fs.readFileSync(".github/workflows/jira-ready-comment.yml","utf8");
const readyWriter=fs.readFileSync("scripts/ci/prepare-jira-ready-comment.mjs","utf8");

test("trusted Jira handoff is sourced from the protected default branch",()=>{
  assert.match(workflow,/workflow_run:/);
  assert.match(workflow,/workflows: \["CI"\]/);
  assert.match(workflow,/pull_request_target:/);
  assert.match(workflow,/types: \[opened, edited, ready_for_review, reopened, synchronize, converted_to_draft\]/);
  assert.match(workflow,/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow,/persist-credentials: false/);
  assert.doesNotMatch(workflow,/ref:.*workflow_run\.head_sha/);
  assert.doesNotMatch(workflow,/ref:.*pull_request|checkout.*pull_request|github\.event\.pull_request\.head\.sha/);
});

test("credential-bearing job has narrow permissions and executes no PR dependencies",()=>{
  assert.match(workflow,/contents: read/);
  assert.match(workflow,/actions: read/);
  assert.match(workflow,/pull-requests: read/);
  assert.match(workflow,/checks: write/);
  assert.doesNotMatch(workflow,/contents: write/);
  assert.doesNotMatch(workflow,/pnpm install|npm install|yarn install|curl |Invoke-WebRequest/);
  assert.match(workflow,/node scripts\/ci\/verify-jira-handoff\.mjs/);
});

test("Jira secrets reach only the trusted verifier step",()=>{
  for(const name of ["JIRA_BASE_URL","JIRA_EMAIL","JIRA_API_TOKEN","JIRA_SERVICE_ACCOUNT_ID"]){
    assert.ok(workflow.includes(name + ": ${{ secrets." + name + " }}"));
  }
  assert.doesNotMatch(workflow,/echo.*JIRA_|printenv|set -x/);
});

test("trusted verifier avoids command execution and response-body logging",()=>{
  assert.doesNotMatch(verifier,/child_process|execSync|spawnSync|eval\(|new Function/);
  assert.doesNotMatch(verifier,/response\.text\(|console\.log\(.*(?:token|body|response)/i);
  assert.match(verifier,/request failed with HTTP/);
  assert.match(verifier,/ready evidence was not authored by the configured Jira service account/);
});

test("manual ready-comment upsert remains protected, narrow, and transition-free",()=>{
  assert.match(readyWorkflow,/workflow_dispatch:/);
  assert.doesNotMatch(readyWorkflow,/pull_request(?:_target)?:|workflow_run:/);
  assert.match(readyWorkflow,/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(readyWorkflow,/persist-credentials: false/);
  assert.doesNotMatch(readyWorkflow,/contents: write|checks: write|pnpm install|npm install|yarn install/);
  assert.match(readyWorkflow,/node scripts\/ci\/prepare-jira-ready-comment\.mjs/);
  assert.doesNotMatch(readyWriter,/\/transitions|child_process|execSync|spawnSync|eval\(/);
  assert.match(readyWriter,/duplicate bot-owned ready comments/);
});