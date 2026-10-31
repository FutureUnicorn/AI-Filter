import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const postMergeWorkflow=fs.readFileSync(".github/workflows/jira-post-merge.yml","utf8");
const reconciliationWorkflow=fs.readFileSync(".github/workflows/jira-reconciliation.yml","utf8");
const postMerge=fs.readFileSync("scripts/ci/sync-jira-delivery-comment.mjs","utf8");
const reconciliation=fs.readFileSync("scripts/ci/reconcile-github-jira.mjs","utf8");

test("post-merge evidence is driven by successful target-branch CI from protected code",()=>{
  assert.match(postMergeWorkflow,/workflow_run:/);
  assert.match(postMergeWorkflow,/workflows: \["CI"\]/);
  assert.match(postMergeWorkflow,/workflow_run\.event == 'push'/);
  assert.match(postMergeWorkflow,/head_branch == 'develop'/);
  assert.match(postMergeWorkflow,/head_branch == 'main'/);
  assert.match(postMergeWorkflow,/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(postMergeWorkflow,/persist-credentials: false/);
  assert.match(postMergeWorkflow,/cancel-in-progress: false/);
  assert.doesNotMatch(postMergeWorkflow,/pull_request_target:|pnpm install|npm install|yarn install/);
});

test("post-merge implementation upserts evidence but has no Jira transition path",()=>{
  assert.match(postMerge,/method:"POST"/);
  assert.match(postMerge,/method:"PUT"/);
  assert.doesNotMatch(postMerge,/\/transitions|method:"DELETE"|child_process|execSync|spawnSync|eval\(/);
  assert.match(postMerge,/Target-branch CI \/ Required did not succeed/);
  assert.match(postMerge,/duplicate bot-owned merged comments/);
  assert.match(postMerge,/recommendDone/);
});

test("scheduled reconciliation is read-only, bounded, and persists a report artifact",()=>{
  assert.match(reconciliationWorkflow,/schedule:/);
  assert.match(reconciliationWorkflow,/workflow_dispatch:/);
  assert.match(reconciliationWorkflow,/Jira Reconciliation \/ Read Only/);
  assert.match(reconciliationWorkflow,/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(reconciliationWorkflow,/persist-credentials: false/);
  assert.doesNotMatch(reconciliationWorkflow,/contents: write|pull-requests: write|issues: write|checks: write/);
  assert.match(reconciliationWorkflow,/actions\/upload-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(reconciliation,/method:"POST"|method:"PUT"|method:"PATCH"|method:"DELETE"|\/transitions/);
  assert.match(reconciliation,/lookbackDays must be an integer from 1 to 90/);
  assert.match(reconciliation,/No Jira comments or statuses were changed/);
});
