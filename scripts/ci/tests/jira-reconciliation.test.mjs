import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { reconcileDelivery, renderReconciliationMarkdown } from "../reconcile-github-jira.mjs";
import { extractStructuredMetadata } from "../validate-delivery-metadata.mjs";
import { mergedMarker } from "../sync-jira-delivery-comment.mjs";

const REPO="FutureUnicorn/AI-Filter", BOT="jira-bot-account";
const HEAD="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERGE="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const fixture=fs.readFileSync(new URL("./fixtures/valid-pr.md",import.meta.url),"utf8").replace(/\r\n/g,"\n");
const adf=(text)=>({type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text}]}]});
function body(withDependency=false){
  const metadata=extractStructuredMetadata(fixture);
  if(withDependency)metadata.dependencies=[{ticket:"AF-106",relationship:"is blocked by",reference:"AF-107",source:"https://hemnaathusa.atlassian.net/browse/AF-107",nativeLink:"https://hemnaathusa.atlassian.net/browse/AF-107",status:"In Progress",blockingStage:"merge",effect:"Review cannot finish",owner:"Platform team",nextAction:"Resolve AF-107"}];
  metadata.readyEvidence={
    prNumber:96,targetBase:"develop",headSha:HEAD,
    ciUrl:"https://github.com/FutureUnicorn/AI-Filter/actions/runs/499",status:"passed",
    jiraComments:["https://hemnaathusa.atlassian.net/browse/AF-106?focusedCommentId=55"]
  };
  const readable=withDependency?fixture.replace("None - the code-delivery scope has no unresolved merge or deployment dependency.","AF-106 is blocked by AF-107 at the merge stage."):fixture;
  return readable.replace(/```json\n[\s\S]*?\n```/,"```json\n"+JSON.stringify(metadata,null,2)+"\n```");
}
function fullPr(customBody=body()){
  return{
    number:96,state:"closed",merged_at:"2026-10-30T00:00:00Z",updated_at:"2026-10-30T01:00:00Z",
    merge_commit_sha:MERGE,title:"AF-106: provider adapters",body:customBody,html_url:"https://github.com/FutureUnicorn/AI-Filter/pull/96",
    head:{sha:HEAD},base:{ref:"develop"}
  };
}
function mockApi({commentMode="exact",ci=true,invalidBody=false,jiraFails=false,dependency=false}={}){
  const calls=[],pr=fullPr(invalidBody?"No delivery metadata":body(dependency));
  return{
    calls,
    api:{
      async github(path,options={}){
        calls.push({service:"github",path,options});
        if(path.includes("/pulls?state=closed&base=develop"))return[pr];
        if(path.includes("/pulls?state=closed&base=main"))return[];
        if(path===`/repos/${REPO}/pulls/96`)return pr;
        if(path.includes("/actions/workflows/ci.yml/runs?"))return{
          workflow_runs:ci?[{
            id:500,conclusion:"success",head_sha:MERGE,head_branch:"develop",
            html_url:"https://github.com/FutureUnicorn/AI-Filter/actions/runs/500"
          }]:[]
        };
        throw new Error(`Unexpected GitHub path ${path}`);
      },
      async jira(path,options={}){
        calls.push({service:"jira",path,options});
        if(jiraFails)throw new Error("simulated unavailable Jira");
        if(path.includes("/issue/AF-107?"))return{key:"AF-107",fields:{status:{name:"In Progress",statusCategory:{key:"indeterminate"}},issuelinks:[]}};
        if(path.includes("?fields=status,issuelinks"))return{
          key:"AF-106",fields:{status:{name:"In Review",statusCategory:{key:"indeterminate"}},issuelinks:dependency?[{type:{inward:"is blocked by",outward:"blocks"},inwardIssue:{key:"AF-107"}}]:[]}
        };
        if(path.includes("/comment?")){
          const exact=mergedMarker({repository:REPO,prNumber:96,headSha:HEAD,mergeSha:MERGE,base:"develop"});
          const stale=mergedMarker({repository:REPO,prNumber:96,headSha:HEAD,mergeSha:"cccccccccccccccccccccccccccccccccccccccc",base:"develop"});
          const comments=commentMode==="missing"?[]:[{id:"66",author:{accountId:BOT},body:adf(commentMode==="exact"?exact:stale)}];
          return{startAt:0,total:comments.length,comments};
        }
        throw new Error(`Unexpected Jira path ${path}`);
      }
    }
  };
}
const options=(api)=>({
  repository:REPO,lookbackDays:14,serviceAccountId:BOT,api,now:new Date("2026-10-31T00:00:00Z")
});

test("read-only reconciliation proves matching merge evidence",async()=>{
  const {api,calls}=mockApi();
  const report=await reconcileDelivery(options(api));
  assert.equal(report.pullRequests,1);
  assert.equal(report.records.length,1);
  assert.equal(report.records[0].status,"verified");
  assert.equal(report.records[0].confidence,"proven");
  assert.equal(calls.some((call)=>call.options.method),false);
});

test("missing and stale merge comments produce scoped replay proposals",async()=>{
  const missing=await reconcileDelivery(options(mockApi({commentMode:"missing"}).api));
  assert.equal(missing.records[0].status,"missing-merge-evidence");
  assert.match(missing.records[0].proposal,/Replay the protected post-merge sync/);
  const stale=await reconcileDelivery(options(mockApi({commentMode:"stale"}).api));
  assert.equal(stale.records[0].status,"stale-merge-evidence");
});

test("current native-link blockers are reported as dependency drift",async()=>{
  const report=await reconcileDelivery(options(mockApi({dependency:true}).api));
  assert.equal(report.records[0].status,"dependency-drift");
  assert.match(report.records[0].proposal,/native Jira links and unresolved review or merge blockers/);
});
test("missing target CI blocks any Jira inference",async()=>{
  const {api,calls}=mockApi({ci:false});
  const report=await reconcileDelivery(options(api));
  assert.equal(report.records[0].status,"missing-target-ci");
  assert.equal(calls.some((call)=>call.service==="jira"),false);
});

test("invalid historical PR metadata becomes a correction proposal without guessed tickets",async()=>{
  const {api,calls}=mockApi({invalidBody:true});
  const report=await reconcileDelivery(options(api));
  assert.equal(report.records[0].status,"invalid-metadata");
  assert.equal(report.records[0].ticket,null);
  assert.equal(calls.some((call)=>call.service==="jira"),false);
});

test("Jira outages are unknown rather than false drift or success",async()=>{
  const report=await reconcileDelivery(options(mockApi({jiraFails:true}).api));
  assert.equal(report.records[0].status,"unknown-jira");
  assert.equal(report.records[0].confidence,"unknown");
  assert.match(report.records[0].proposal,/make no status correction/);
});

test("report is human-readable and explicitly read-only",async()=>{
  const report=await reconcileDelivery(options(mockApi().api));
  const markdown=renderReconciliationMarkdown(report);
  assert.match(markdown,/# GitHub-Jira delivery reconciliation/);
  assert.match(markdown,/verified: 1/);
  assert.match(markdown,/No Jira comments or statuses were changed/);
  assert.doesNotMatch(markdown,/simulated unavailable|JIRA_API_TOKEN/);
});

test("lookback bounds prevent accidental unbounded historical scans",async()=>{
  const {api}=mockApi();
  await assert.rejects(reconcileDelivery({...options(api),lookbackDays:0}),/integer from 1 to 90/);
  await assert.rejects(reconcileDelivery({...options(api),lookbackDays:91}),/integer from 1 to 90/);
});
