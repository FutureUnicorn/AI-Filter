#!/usr/bin/env node
// AF-DELIVERY-1.0 manual, trusted ready-comment upsert.
// Runs from protected default-branch code and never executes the PR revision.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { extractStructuredMetadata, validateDeliveryMetadata } from "./validate-delivery-metadata.mjs";
import {
  createApiClient,
  flattenAdf,
  readyMarker,
  resolveCurrentCiRunId,
  verifyDeclaredDependencies
} from "./verify-jira-handoff.mjs";

const REPO="FutureUnicorn/AI-Filter";
const AF=/^AF-\d+$/;
const cap=(value,length=1000)=>Array.from(String(value??""),(character)=>{const code=character.charCodeAt(0);return code<32&&code!==9&&code!==10&&code!==13?" ":character}).join("").slice(0,length);
function need(value,name){if(typeof value!=="string"||!value.trim())throw new Error(`Missing required configuration: ${name}.`);return value}
function safeBody(body,metadata){
  const copy=structuredClone(metadata);copy.readyEvidence=null;
  return body.replace(/(```json\r?\n)[\s\S]*?(\r?\n```)/,(_,open,close)=>open+JSON.stringify(copy,null,2)+close);
}
const done=(issue)=>issue?.fields?.status?.statusCategory?.key==="done";

export function readyCommentText(metadata,{repository,prNumber,base,headSha,ciUrl}){
  const lines=[
    "Signal Audit delivery evidence is ready for human review.",
    "",
    `Pull request: https://github.com/${repository}/pull/${prNumber}`,
    `Target branch: ${cap(base,100)}`,
    `Current head: ${headSha}`,
    `Verified CI: ${ciUrl}`,
    "",
    "Contributor-reported acceptance status:"
  ];
  for(const ticket of metadata.tickets){
    const counts=new Map(["Met","Unmet","Deferred","Not verified"].map((status)=>[status,0]));
    for(const criterion of ticket.acceptance)counts.set(criterion.status,counts.get(criterion.status)+1);
    lines.push(
      `- ${ticket.key}: ${[...counts].map(([status,count])=>`${status} ${count}`).join("; ")}. See the PR and Jira criterion text for details.`
    );
  }
  lines.push("","Declared dependencies:");
  if(metadata.dependencies.length===0)lines.push("- No delivery dependency declared.");
  for(const dependency of metadata.dependencies){
    const reference=AF.test(dependency.reference??"")?dependency.reference:"an external dependency";
    lines.push(
      `- ${dependency.ticket} ${dependency.relationship} ${reference}; blocking stage: ${dependency.blockingStage}. Jira-native links are API-verified where applicable.`
    );
  }
  const testCounts=new Map(["automated","mocked","live","manual","unverified"].map((classification)=>[classification,0]));
  for(const evidence of metadata.tests)testCounts.set(evidence.classification,testCounts.get(evidence.classification)+1);
  lines.push(
    "",
    `Verification classifications: ${[...testCounts].map(([classification,count])=>`${classification} ${count}`).join("; ")}.`,
    "Commands, results, acceptance details, owners, rollout, and limitations remain in the reviewable PR metadata.",
    "The Jira service account verified repository, PR, base, current head, aggregate CI, ticket existence, native links, and blocker stage.",
    "A human evidence owner and independent reviewer still decide whether the evidence and scope are acceptable.",
    "AI supplies delivery evidence; humans retain product and hiring decisions.",
    "",
    readyMarker(repository,prNumber,headSha)
  );
  const text=lines.join("\n");
  if(text.length>30000)throw new Error("Ready comment exceeds the 30000-character safety limit.");
  return text;
}export const commentAdf=(text)=>({
  type:"doc",version:1,content:text.split("\n").map((line)=>({
    type:"paragraph",content:line?[{type:"text",text:line}]:[]
  }))
});

async function allComments(api,key){
  const result=[];let startAt=0;
  for(let page=0;page<100;page+=1){
    const response=await api.jira(`/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
    const current=Array.isArray(response.comments)?response.comments:[];result.push(...current);
    if(result.length>=Number(response.total??result.length)||current.length===0)return result;
    startAt+=current.length;
  }
  throw new Error(`Jira comments for ${key} exceeded the pagination limit.`);
}
async function jiraIssue(api,key){
  const issue=await api.jira(`/rest/api/3/issue/${key}?fields=status,issuelinks`);
  if(issue?.key!==key||!issue.fields)throw new Error(`Jira issue ${key} could not be verified.`);
  return issue;
}
async function authoritativeContext(api,repository,number){
  const runId=await resolveCurrentCiRunId(api,repository,{pull_request:{number}});
  const run=await api.github(`/repos/${repository}/actions/runs/${runId}`);
  const pr=await api.github(`/repos/${repository}/pulls/${number}`);
  const jobs=await api.github(`/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  const required=(Array.isArray(jobs.jobs)?jobs.jobs:[]).find((v)=>v.name==="CI / Required");
  if(
    run.name!=="CI"||run.path!==".github/workflows/ci.yml"||run.event!=="pull_request"||run.status!=="completed"||run.conclusion!=="success"||
    run.head_sha!==pr.head?.sha||pr.state!=="open"||required?.conclusion!=="success"
  )throw new Error("Current-head CI / Required has not succeeded for this open pull request.");
  return{
    pr,run,context:{prNumber:number,title:pr.title,body:pr.body??"",base:pr.base?.ref,headSha:pr.head.sha,isDraft:true}
  };
}
export async function prepareReadyComments({repository,prNumber,serviceAccountId,api}){
  if(repository!==REPO)throw new Error("Ready-comment preparation is restricted to FutureUnicorn/AI-Filter.");
  need(serviceAccountId,"JIRA_SERVICE_ACCOUNT_ID");
  const {pr,run,context}=await authoritativeContext(api,repository,prNumber);
  const metadata=extractStructuredMetadata(context.body);
  const validation=validateDeliveryMetadata(safeBody(context.body,metadata),context);
  if(!validation.ok)throw new Error(`Delivery metadata needs attention: ${validation.errors.slice(0,10).join(" | ")}`);

  const keys=new Set(validation.issueKeys);
  for(const d of metadata.dependencies)if(AF.test(d.reference??""))keys.add(d.reference);
  const issues=new Map();
  for(const key of [...keys].sort())issues.set(key,await jiraIssue(api,key));
  const dependencies=verifyDeclaredDependencies(metadata,issues);
  if(dependencies.errors.length)throw new Error(`Dependency verification failed: ${dependencies.errors.join(" | ")}`);

  const text=readyCommentText(metadata,{
    repository,prNumber,base:pr.base.ref,headSha:pr.head.sha,ciUrl:run.html_url
  });
  const markerPrefix=`[AF-DELIVERY v1 stage=ready repo=${repository} pr=${prNumber} head=`;
  const results=[];
  for(const key of validation.issueKeys){
    if(done(issues.get(key)))throw new Error(`${key} is already in a Done-category status; a ready-for-review comment would misstate its stage.`);
    const owned=(await allComments(api,key)).filter(
      (comment)=>comment.author?.accountId===serviceAccountId&&flattenAdf(comment.body).includes(markerPrefix)
    );
    if(owned.length>1)throw new Error(`${key} has duplicate bot-owned ready comments; human cleanup is required before retry.`);
    const payload={body:commentAdf(text)};
    const saved=owned.length===1
      ? await api.jira(`/rest/api/3/issue/${key}/comment/${owned[0].id}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(payload)})
      : await api.jira(`/rest/api/3/issue/${key}/comment`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    if(!/^\d+$/.test(String(saved?.id??"")))throw new Error(`Jira did not return a valid comment id for ${key}.`);
    results.push({key,id:String(saved.id),url:`https://hemnaathusa.atlassian.net/browse/${key}?focusedCommentId=${saved.id}`,action:owned.length?"updated":"created"});
  }
  return{headSha:pr.head.sha,ciUrl:run.html_url,warnings:dependencies.warnings,comments:results};
}
async function main(){
  try{
    const event=JSON.parse(fs.readFileSync(need(process.env.GITHUB_EVENT_PATH,"GITHUB_EVENT_PATH"),"utf8"));
    const prNumber=Number(event?.inputs?.pr_number);
    if(!Number.isInteger(prNumber)||prNumber<1)throw new Error("pr_number must be a positive integer.");
    const api=createApiClient({jiraBaseUrl:process.env.JIRA_BASE_URL,jiraEmail:process.env.JIRA_EMAIL,jiraToken:process.env.JIRA_API_TOKEN,githubToken:process.env.GITHUB_TOKEN,githubApiUrl:process.env.GITHUB_API_URL});
    const result=await prepareReadyComments({repository:need(process.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY"),prNumber,serviceAccountId:process.env.JIRA_SERVICE_ACCOUNT_ID,api});
    process.stdout.write(`Ready comments prepared for head ${result.headSha}.\n`);
    for(const comment of result.comments)process.stdout.write(`${comment.key}: ${comment.action} ${comment.url}\n`);
    for(const warning of result.warnings)process.stdout.write(`Limitation: ${warning}\n`);
  }catch(error){
    process.stderr.write(`${error instanceof Error?error.message:"Ready-comment preparation failed."}\n`);
    process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
