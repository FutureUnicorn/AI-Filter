import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { prepareReadyComments, readyCommentText } from "../prepare-jira-ready-comment.mjs";
import { extractStructuredMetadata } from "../validate-delivery-metadata.mjs";
import { readyMarker } from "../verify-jira-handoff.mjs";

const HEAD="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO="FutureUnicorn/AI-Filter", BOT="jira-bot-account", RUN=123;
const CI_URL="https://github.com/FutureUnicorn/AI-Filter/actions/runs/123";
const body=fs.readFileSync(new URL("./fixtures/valid-pr.md",import.meta.url),"utf8");
const adf=(text)=>({type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text}]}]});

function mockApi({comments=[],statusCategory="indeterminate"}={}){
  const calls=[];
  return{
    calls,
    api:{
      async github(path,options={}){
        calls.push({service:"github",path,options});
        if(path===`/repos/${REPO}/pulls/96`)return{
          number:96,state:"open",draft:true,title:"AF-106: provider adapters",body,
          head:{sha:HEAD},base:{ref:"develop"}
        };
        if(path.includes("/actions/workflows/ci.yml/runs?"))return{
          workflow_runs:[{id:RUN,conclusion:"success",pull_requests:[{number:96}]}]
        };
        if(path===`/repos/${REPO}/actions/runs/${RUN}`)return{
          id:RUN,name:"CI",path:".github/workflows/ci.yml",event:"pull_request",status:"completed",conclusion:"success",head_sha:HEAD,
          html_url:CI_URL,pull_requests:[{number:96}]
        };
        if(path.includes("/jobs?"))return{jobs:[{name:"CI / Required",status:"completed",conclusion:"success"}]};
        throw new Error(`Unexpected GitHub path ${path}`);
      },
      async jira(path,options={}){
        calls.push({service:"jira",path,options});
        if(path.includes("?fields=status,issuelinks"))return{
          key:"AF-106",fields:{status:{statusCategory:{key:statusCategory}},issuelinks:[]}
        };
        if(path.includes("/comment?"))return{startAt:0,total:comments.length,comments};
        if(options.method==="POST")return{id:"55"};
        if(options.method==="PUT")return{id:path.split("/").at(-1)};
        throw new Error(`Unexpected Jira path ${path}`);
      }
    }
  };
}

test("manual trusted handoff creates one bot-owned ready comment",async()=>{
  const {api,calls}=mockApi();
  const result=await prepareReadyComments({repository:REPO,prNumber:96,serviceAccountId:BOT,api});
  assert.equal(result.headSha,HEAD);
  assert.deepEqual(result.comments,[{
    key:"AF-106",id:"55",
    url:"https://hemnaathusa.atlassian.net/browse/AF-106?focusedCommentId=55",
    action:"created"
  }]);
  const write=calls.find((call)=>call.options.method==="POST");
  assert.equal(write.path,"/rest/api/3/issue/AF-106/comment");
  const payload=JSON.parse(write.options.body);
  assert.ok(JSON.stringify(payload).includes(readyMarker(REPO,96,HEAD)));
  assert.equal(calls.some((call)=>call.path.includes("/transitions")),false);
});

test("retry updates the bot's own stage-and-PR comment instead of duplicating it",async()=>{
  const old=readyMarker(REPO,96,"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const {api,calls}=mockApi({comments:[{id:"42",author:{accountId:BOT},body:adf(old)}]});
  const result=await prepareReadyComments({repository:REPO,prNumber:96,serviceAccountId:BOT,api});
  assert.equal(result.comments[0].action,"updated");
  assert.ok(calls.some((call)=>call.options.method==="PUT"&&call.path.endsWith("/comment/42")));
  assert.equal(calls.some((call)=>call.options.method==="POST"),false);
});

test("a copied marker in a person's comment is never edited",async()=>{
  const copied=readyMarker(REPO,96,"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const {api,calls}=mockApi({comments:[{id:"42",author:{accountId:"human"},body:adf(copied)}]});
  const result=await prepareReadyComments({repository:REPO,prNumber:96,serviceAccountId:BOT,api});
  assert.equal(result.comments[0].action,"created");
  assert.equal(calls.some((call)=>call.options.method==="PUT"),false);
  assert.ok(calls.some((call)=>call.options.method==="POST"));
});

test("duplicate bot-owned comments stop for human cleanup",async()=>{
  const marker=readyMarker(REPO,96,HEAD);
  const duplicate=[
    {id:"41",author:{accountId:BOT},body:adf(marker)},
    {id:"42",author:{accountId:BOT},body:adf(marker)}
  ];
  const {api,calls}=mockApi({comments:duplicate});
  await assert.rejects(
    prepareReadyComments({repository:REPO,prNumber:96,serviceAccountId:BOT,api}),
    /duplicate bot-owned ready comments/
  );
  assert.equal(calls.some((call)=>["POST","PUT"].includes(call.options.method)),false);
});

test("a Done ticket cannot receive a misleading ready-for-review comment",async()=>{
  const {api,calls}=mockApi({statusCategory:"done"});
  await assert.rejects(
    prepareReadyComments({repository:REPO,prNumber:96,serviceAccountId:BOT,api}),
    /already in a Done-category status/
  );
  assert.equal(calls.some((call)=>["POST","PUT"].includes(call.options.method)),false);
});

test("plain-language comment separates trusted facts from contributor reports",()=>{
  const metadata=extractStructuredMetadata(body);
  const text=readyCommentText(metadata,{
    repository:REPO,prNumber:96,base:"develop",headSha:HEAD,ciUrl:CI_URL
  });
  assert.match(text,/Signal Audit delivery evidence is ready for human review/);
  assert.match(text,/Contributor-reported acceptance status/);
  assert.match(text,/human evidence owner and independent reviewer/i);
  assert.match(text,/still decide whether the evidence/);
  assert.ok(text.endsWith(readyMarker(REPO,96,HEAD)));
  assert.equal(text.includes("tests/integration"),false);
  assert.doesNotMatch(text,/Jane Engineer|ticket is Done|acceptance is approved/i);
});
