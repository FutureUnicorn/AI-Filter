import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { mergedCommentText, mergedMarker, syncMergedDelivery } from "../sync-jira-delivery-comment.mjs";
import { extractStructuredMetadata } from "../validate-delivery-metadata.mjs";
import { readyMarker } from "../verify-jira-handoff.mjs";

const REPO="FutureUnicorn/AI-Filter", BOT="jira-bot-account", RUN=500;
const HEAD="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERGE="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TARGET_CI="https://github.com/FutureUnicorn/AI-Filter/actions/runs/500";
const READY_CI="https://github.com/FutureUnicorn/AI-Filter/actions/runs/499";
const fixture=fs.readFileSync(new URL("./fixtures/valid-pr.md",import.meta.url),"utf8").replace(/\r\n/g,"\n");
const adf=(text)=>({type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text}]}]});
function readyBody(){
  const metadata=extractStructuredMetadata(fixture);
  metadata.readyEvidence={
    prNumber:96,targetBase:"develop",headSha:HEAD,ciUrl:READY_CI,status:"passed",
    jiraComments:["https://hemnaathusa.atlassian.net/browse/AF-106?focusedCommentId=55"]
  };
  return fixture.replace(/```json\n[\s\S]*?\n```/,"```json\n"+JSON.stringify(metadata,null,2)+"\n```");
}
function mockApi({targetConclusion="success",readyAuthor=BOT,extraComments=[],base="develop"}={}){
  const calls=[];
  const ready={id:"55",author:{accountId:readyAuthor},body:adf(readyMarker(REPO,96,HEAD))};
  return{
    calls,
    api:{
      async github(path,options={}){
        calls.push({service:"github",path,options});
        if(path===`/repos/${REPO}/actions/runs/${RUN}`)return{
          id:RUN,name:"CI",path:".github/workflows/ci.yml",event:"push",status:"completed",
          conclusion:"success",head_branch:base,head_sha:MERGE,html_url:TARGET_CI
        };
        if(path===`/repos/${REPO}/commits/${MERGE}/pulls`)return[{
          number:96,merged_at:"2026-10-31T00:00:00Z",merge_commit_sha:MERGE,base:{ref:base}
        }];
        if(path===`/repos/${REPO}/pulls/96`)return{
          number:96,state:"closed",draft:false,merged_at:"2026-10-31T00:00:00Z",
          merge_commit_sha:MERGE,title:"AF-106: provider adapters",body:readyBody(),
          head:{sha:HEAD},base:{ref:base}
        };
        if(path.includes("/jobs?"))return{jobs:[{name:"CI / Required",status:"completed",conclusion:targetConclusion}]};
        throw new Error(`Unexpected GitHub path ${path}`);
      },
      async jira(path,options={}){
        calls.push({service:"jira",path,options});
        if(path.includes("?fields=status,issuelinks"))return{
          key:"AF-106",fields:{status:{name:"In Review",statusCategory:{key:"indeterminate"}},issuelinks:[]}
        };
        if(path.includes("/comment?"))return{startAt:0,total:1+extraComments.length,comments:[ready,...extraComments]};
        if(options.method==="POST")return{id:"66"};
        if(options.method==="PUT")return{id:path.split("/").at(-1)};
        throw new Error(`Unexpected Jira path ${path}`);
      }
    }
  };
}

test("successful target CI creates one merged evidence comment without transitions",async()=>{
  const {api,calls}=mockApi();
  const result=await syncMergedDelivery({repository:REPO,runId:RUN,serviceAccountId:BOT,api});
  assert.equal(result.mergeSha,MERGE);
  assert.deepEqual(result.comments,[{key:"AF-106",id:"66",action:"created",recommendDone:false}]);
  const write=calls.find((call)=>call.options.method==="POST");
  assert.ok(JSON.stringify(JSON.parse(write.options.body)).includes(mergedMarker({
    repository:REPO,prNumber:96,headSha:HEAD,mergeSha:MERGE,base:"develop"
  })));
  assert.equal(calls.some((call)=>call.path.includes("/transitions")),false);
});

test("replay updates the same bot-owned merged comment",async()=>{
  const marker=mergedMarker({repository:REPO,prNumber:96,headSha:HEAD,mergeSha:MERGE,base:"develop"});
  const {api,calls}=mockApi({extraComments:[{id:"66",author:{accountId:BOT},body:adf(marker)}]});
  const result=await syncMergedDelivery({repository:REPO,runId:RUN,serviceAccountId:BOT,api});
  assert.equal(result.comments[0].action,"updated");
  assert.ok(calls.some((call)=>call.options.method==="PUT"&&call.path.endsWith("/comment/66")));
  assert.equal(calls.some((call)=>call.options.method==="POST"),false);
});

test("duplicate merged comments stop rather than overwriting evidence",async()=>{
  const marker=mergedMarker({repository:REPO,prNumber:96,headSha:HEAD,mergeSha:MERGE,base:"develop"});
  const duplicates=[
    {id:"66",author:{accountId:BOT},body:adf(marker)},
    {id:"67",author:{accountId:BOT},body:adf(marker)}
  ];
  const {api,calls}=mockApi({extraComments:duplicates});
  await assert.rejects(
    syncMergedDelivery({repository:REPO,runId:RUN,serviceAccountId:BOT,api}),
    /duplicate bot-owned merged comments/
  );
  assert.equal(calls.some((call)=>["POST","PUT"].includes(call.options.method)),false);
});

test("a human-authored copied ready marker cannot authorize merge evidence",async()=>{
  const {api,calls}=mockApi({readyAuthor:"human"});
  await assert.rejects(
    syncMergedDelivery({repository:REPO,runId:RUN,serviceAccountId:BOT,api}),
    /does not have authorized ready evidence/
  );
  assert.equal(calls.some((call)=>["POST","PUT"].includes(call.options.method)),false);
});

test("feature-branch delivery and failed target CI cannot be reported as merged",async()=>{
  const feature=mockApi({base:"feature/stack"});
  await assert.rejects(
    syncMergedDelivery({repository:REPO,runId:RUN,serviceAccountId:BOT,api:feature.api}),
    /not a successful authoritative target-branch CI run/
  );
  const failed=mockApi({targetConclusion:"failure"});
  await assert.rejects(
    syncMergedDelivery({repository:REPO,runId:RUN,serviceAccountId:BOT,api:failed.api}),
    /Target-branch CI \/ Required did not succeed/
  );
});

test("Done is only recommended when acceptance, tests, and later-stage dependencies are complete",()=>{
  const metadata=extractStructuredMetadata(fixture);
  metadata.tests=metadata.tests.filter((record)=>record.classification!=="unverified");
  const ticket=metadata.tickets[0];
  const complete=mergedCommentText({
    metadata,ticket,repository:REPO,prNumber:96,headSha:HEAD,mergeSha:MERGE,base:"develop",
    targetCiUrl:TARGET_CI,limitations:[],currentStatus:"In Review"
  });
  assert.equal(complete.recommendDone,true);
  assert.match(complete.text,/human may evaluate moving this ticket to Done/);
  const limited=mergedCommentText({
    metadata,ticket,repository:REPO,prNumber:96,headSha:HEAD,mergeSha:MERGE,base:"develop",
    targetCiUrl:TARGET_CI,limitations:["AF-106 retains a deployment limitation."],currentStatus:"In Review"
  });
  assert.equal(limited.recommendDone,false);
  assert.match(limited.text,/keep the current Jira status/);
});
