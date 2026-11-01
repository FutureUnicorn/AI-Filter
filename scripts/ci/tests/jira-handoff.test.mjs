import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  SafeApiError,
  createApiClient,
  flattenAdf,
  readyMarker,
  resolveCurrentCiRunId,
  verifyDeclaredDependencies,
  verifyJiraHandoff
} from "../verify-jira-handoff.mjs";

const HEAD="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN=123;
const REPO="FutureUnicorn/AI-Filter";
const BOT="jira-bot-account";
const CI_URL="https://github.com/FutureUnicorn/AI-Filter/actions/runs/123";
const fixture=new URL("./fixtures/valid-pr.md",import.meta.url);

function readyBody(change=(metadata)=>metadata){
  const source=fs.readFileSync(fixture,"utf8");
  const match=/```json\r?\n([\s\S]*?)\r?\n```/.exec(source);
  const metadata=JSON.parse(match[1]);
  metadata.readyEvidence={
    prNumber:96,targetBase:"develop",headSha:HEAD,ciUrl:CI_URL,status:"passed",
    jiraComments:["https://hemnaathusa.atlassian.net/browse/AF-106?focusedCommentId=55"]
  };
  change(metadata);
  return source.replace(match[0], "```json\n" + JSON.stringify(metadata, null, 2) + "\n```");
}
const adf=(text)=>({type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text}]}]});
function baseApi({body=readyBody(),head=HEAD,job="success",author=BOT,marker=readyMarker(REPO,96,HEAD),ciUrl=CI_URL,runPath=".github/workflows/ci.yml"}={}){
  const githubCalls=[],jiraCalls=[];
  return{
    githubCalls,jiraCalls,
    api:{
      async github(path){
        githubCalls.push(path);
        if(path===`/repos/${REPO}/actions/runs/${RUN}`)return{
          id:RUN,name:"CI",path:runPath,event:"pull_request",status:"completed",conclusion:"success",
          head_sha:HEAD,html_url:ciUrl,pull_requests:[{number:96}]
        };
        if(path===`/repos/${REPO}/pulls/96`)return{
          number:96,state:"open",draft:false,title:"AF-106: provider adapters",body,
          head:{sha:head},base:{ref:"develop"}
        };
        if(path.includes("/jobs?"))return{jobs:[{name:"CI / Required",status:"completed",conclusion:job}]};
        throw new Error(`Unexpected GitHub path ${path}`);
      },
      async jira(path){
        jiraCalls.push(path);
        if(path.includes("/comment?"))return{
          startAt:0,total:1,comments:[{id:"55",author:{accountId:author},body:adf(marker)}]
        };
        if(path.includes("/issue/AF-106?"))return{
          key:"AF-106",fields:{status:{statusCategory:{key:"indeterminate"}},issuelinks:[]}
        };
        throw new Error(`Unexpected Jira path ${path}`);
      }
    }
  };
}

test("trusted verifier accepts current CI, current head, existing ticket, and bot marker",async()=>{
  const {api,githubCalls,jiraCalls}=baseApi();
  const result=await verifyJiraHandoff({repository:REPO,runId:RUN,serviceAccountId:BOT,api});
  assert.equal(result.ok,true);
  assert.deepEqual(result.errors,[]);
  assert.ok(githubCalls.some((path)=>path.includes("/jobs?")));
  assert.ok(jiraCalls.some((path)=>path.includes("fields=status,issuelinks")));
  assert.ok(jiraCalls.some((path)=>path.includes("/comment?")));
});

test("a new PR head invalidates the completed workflow evidence",async()=>{
  const {api}=baseApi({head:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"});
  await assert.rejects(
    verifyJiraHandoff({repository:REPO,runId:RUN,serviceAccountId:BOT,api}),
    /stale, or does not match/
  );
});

test("a same-named workflow at another path cannot satisfy the gate",async()=>{
  const {api}=baseApi({runPath:".github/workflows/not-ci.yml"});
  await assert.rejects(
    verifyJiraHandoff({repository:REPO,runId:RUN,serviceAccountId:BOT,api}),
    /authoritative pull-request CI workflow has not succeeded/
  );
});
test("the aggregate CI job must pass",async()=>{
  const {api}=baseApi({job:"failure"});
  await assert.rejects(
    verifyJiraHandoff({repository:REPO,runId:RUN,serviceAccountId:BOT,api}),
    /CI \/ Required has not succeeded/
  );
});

test("a copied marker from an unauthorized Jira author does not satisfy the gate",async()=>{
  const {api}=baseApi({author:"human-author"});
  const result=await verifyJiraHandoff({repository:REPO,runId:RUN,serviceAccountId:BOT,api});
  assert.equal(result.ok,false);
  assert.match(result.errors.join("\n"),/not authored by the configured Jira service account/);
});

test("a bot comment for an old head is rejected",async()=>{
  const stale=readyMarker(REPO,96,"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const {api}=baseApi({marker:stale});
  const result=await verifyJiraHandoff({repository:REPO,runId:RUN,serviceAccountId:BOT,api});
  assert.equal(result.ok,false);
  assert.match(result.errors.join("\n"),/stale or has a mismatched delivery marker/);
});

test("the claimed CI URL must be the re-fetched workflow run",async()=>{
  const {api}=baseApi({ciUrl:"https://github.com/FutureUnicorn/AI-Filter/actions/runs/999"});
  const result=await verifyJiraHandoff({repository:REPO,runId:RUN,serviceAccountId:BOT,api});
  assert.equal(result.ok,false);
  assert.match(result.errors.join("\n"),/authoritative CI run/);
});

test("native Jira link direction and unresolved review blockers are enforced",()=>{
  const metadata={dependencies:[{
    ticket:"AF-106",reference:"AF-107",relationship:"is blocked by",blockingStage:"merge"
  }]};
  const issues=new Map([
    ["AF-106",{fields:{issuelinks:[{
      type:{inward:"is blocked by",outward:"blocks"},
      inwardIssue:{key:"AF-107"}
    }]}}],
    ["AF-107",{fields:{status:{statusCategory:{key:"indeterminate"}}}}]
  ]);
  const result=verifyDeclaredDependencies(metadata,issues);
  assert.match(result.errors.join("\n"),/remains blocked at merge/);
});

test("unresolved deployment dependencies remain visible limitations",()=>{
  const metadata={dependencies:[{
    ticket:"AF-106",reference:"AF-107",relationship:"depends on",blockingStage:"deployment"
  }]};
  const issues=new Map([
    ["AF-106",{fields:{issuelinks:[{
      type:{inward:"depends on",outward:"is depended on by"},
      inwardIssue:{key:"AF-107"}
    }]}}],
    ["AF-107",{fields:{status:{statusCategory:{key:"indeterminate"}}}}]
  ]);
  const result=verifyDeclaredDependencies(metadata,issues);
  assert.deepEqual(result.errors,[]);
  assert.match(result.warnings.join("\n"),/deployment limitation/);
});

test("external review dependencies fail closed because their status is not API-verifiable",()=>{
  const result=verifyDeclaredDependencies({dependencies:[{
    ticket:"AF-106",reference:"vendor approval",blockingStage:"review"
  }]},new Map());
  assert.match(result.errors.join("\n"),/cannot be independently verified/);
});

test("ADF flattening treats Jira content as data",()=>{
  assert.equal(flattenAdf(adf("$(whoami) <script>")),"$(whoami) <script>");
});

function response(status,payload,headers={}){
  return{
    status,ok:status>=200&&status<300,
    headers:{get:(name)=>headers[name.toLowerCase()]??null},
    json:async()=>payload
  };
}
function client(fetchImpl,sleep=async()=>{}){
  return createApiClient({
    fetchImpl,sleep,jiraBaseUrl:"https://hemnaathusa.atlassian.net",
    jiraEmail:"service@example.test",jiraToken:"never-print-this",
    githubToken:"never-print-this-either"
  });
}

test("Jira retry exhaustion exposes only service and status, never response bodies or credentials",async()=>{
  let count=0;
  const api=client(async()=>{count+=1;return response(503,{secret:"provider response body"});});
  await assert.rejects(api.jira("/rest/api/3/issue/AF-106"),(error)=>{
    assert.ok(error instanceof SafeApiError);
    assert.equal(error.message,"Jira API request failed with HTTP 503.");
    assert.doesNotMatch(error.message,/provider response|never-print/);
    return true;
  });
  assert.equal(count,3);
});

test("429 responses are retried with a bounded delay",async()=>{
  let count=0;const delays=[];
  const api=client(async()=>{
    count+=1;
    return count===1?response(429,{},{"retry-after":"999"}):response(200,{ok:true});
  },async(ms)=>delays.push(ms));
  assert.deepEqual(await api.jira("/rest/api/3/issue/AF-106"),{ok:true});
  assert.equal(count,2);
  assert.deepEqual(delays,[5000]);
});

test("credentials are sent only to generated approved API origins",async()=>{
  const calls=[];
  const api=client(async(url,options)=>{calls.push({url,headers:options.headers});return response(200,{ok:true});});
  await api.jira("/rest/api/3/issue/AF-106");
  await api.github("/repos/FutureUnicorn/AI-Filter/actions/runs/123");
  assert.equal(new URL(calls[0].url).origin,"https://hemnaathusa.atlassian.net");
  assert.match(calls[0].headers.authorization,/^Basic /);
  assert.equal(new URL(calls[1].url).origin,"https://api.github.com");
  assert.match(calls[1].headers.authorization,/^Bearer /);
});

test("PR-description events re-fetch the current head and select its successful CI run",async()=>{
  const calls=[];
  const api={async github(path){
    calls.push(path);
    if(path===`/repos/${REPO}/pulls/96`)return{number:96,head:{sha:HEAD}};
    if(path.includes("/actions/workflows/ci.yml/runs?"))return{
      workflow_runs:[{id:RUN,conclusion:"success",pull_requests:[{number:96}]}]
    };
    throw new Error(`Unexpected path ${path}`);
  }};
  assert.equal(await resolveCurrentCiRunId(api,REPO,{pull_request:{number:96}}),RUN);
  assert.ok(calls[1].includes(`head_sha=${HEAD}`));
});

test("workflow-run events use their run id without trusting PR metadata",async()=>{
  const api={github:async()=>{throw new Error("must not fetch")}};
  assert.equal(await resolveCurrentCiRunId(api,REPO,{workflow_run:{id:RUN}}),RUN);
});

test("API helpers reject absolute paths that could exfiltrate credentials",()=>{
  const api=client(async()=>response(200,{}));
  assert.throws(()=>api.jira("https://evil.example/rest/api/3/issue/AF-106"),/escaped the approved origin/);
  assert.throws(()=>api.github("https://evil.example/repos/x/y"),/escaped the approved origin/);
});