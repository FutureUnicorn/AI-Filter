#!/usr/bin/env node
// AF-DELIVERY-1.0 trusted verification. Run only from protected default-branch code.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { extractStructuredMetadata, validateDeliveryMetadata } from "./validate-delivery-metadata.mjs";

const REPO="FutureUnicorn/AI-Filter", JIRA="https://hemnaathusa.atlassian.net";
const AF=/^AF-\d+$/, REVIEW=new Set(["review","merge"]), LATER=new Set(["deployment","Done"]);
const record=(v)=>typeof v==="object"&&v!==null&&!Array.isArray(v);
function need(v,n){if(typeof v!=="string"||!v.trim())throw new Error(`Missing required configuration: ${n}.`);return v}
const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));

export class SafeApiError extends Error{
  constructor(service,status){super(`${service} request failed with HTTP ${Number.isInteger(status)?status:"unknown"}.`);this.name="SafeApiError"}
}
export function createApiClient({fetchImpl=globalThis.fetch,sleep=wait,jiraBaseUrl,jiraEmail,jiraToken,githubToken,githubApiUrl="https://api.github.com"}){
  if(typeof fetchImpl!=="function")throw new Error("A fetch implementation is required.");
  const jo=new URL(need(jiraBaseUrl,"JIRA_BASE_URL")), gh=new URL(githubApiUrl);
  if(jo.origin!==JIRA||jo.pathname!=="/")throw new Error("JIRA_BASE_URL must be the approved AI_FILTER Jira origin.");
  if(gh.origin!=="https://api.github.com"||gh.pathname!=="/")throw new Error("GITHUB_API_URL must be the approved GitHub API origin.");
  const basic=Buffer.from(`${need(jiraEmail,"JIRA_EMAIL")}:${need(jiraToken,"JIRA_API_TOKEN")}`,"utf8").toString("base64");
  async function json(service,url,options={}){
    for(let attempt=0;attempt<3;attempt+=1){
      let response;
      try{response=await fetchImpl(url,options)}catch{if(attempt===2)throw new SafeApiError(service);await sleep(Math.min(2**attempt*1000,5000));continue}
      const retry=response.status===429||(response.status>=500&&response.status<=599);
      if(retry&&attempt<2){const h=response.headers?.get?.("retry-after");await sleep(Math.min((h&&/^\d+$/.test(h)?Number(h):2**attempt)*1000,5000));continue}
      if(!response.ok)throw new SafeApiError(service,response.status);
      const length=Number(response.headers?.get?.("content-length")??"0");
      if(Number.isFinite(length)&&length>2000000)throw new Error(`${service} response exceeded the configured size limit.`);
      try{return await response.json()}catch{throw new Error(`${service} returned invalid JSON.`)}
    }
  }
  const ghHeaders={accept:"application/vnd.github+json",authorization:`Bearer ${need(githubToken,"GITHUB_TOKEN")}`,"x-github-api-version":"2022-11-28"};
  const jiraHeaders={accept:"application/json",authorization:`Basic ${basic}`};
  return{
    github:(path,options={})=>{const url=new URL(path,gh);if(url.origin!==gh.origin)throw new Error("GitHub API path escaped the approved origin.");return json("GitHub API",url.href,{...options,headers:{...ghHeaders,...(options.headers??{})}})},
    jira:(path,options={})=>{const url=new URL(path,jo);if(url.origin!==jo.origin)throw new Error("Jira API path escaped the approved origin.");return json("Jira API",url.href,{...options,headers:{...jiraHeaders,...(options.headers??{})}})}
  };
}
export function flattenAdf(v){
  if(typeof v==="string")return v;
  if(Array.isArray(v))return v.map(flattenAdf).join("");
  return record(v)?(typeof v.text==="string"?v.text:"")+flattenAdf(v.content):"";
}
export const readyMarker=(repo,pr,sha)=>`[AF-DELIVERY v1 stage=ready repo=${repo} pr=${pr} head=${sha}]`;
function commentId(value,key){
  try{const u=new URL(value),id=u.searchParams.get("focusedCommentId");return u.origin===JIRA&&u.pathname===`/browse/${key}`&&/^\d+$/.test(id??"")?id:null}catch{return null}
}
const done=(issue)=>issue?.fields?.status?.statusCategory?.key==="done";
function relation(link,key){if(link?.outwardIssue?.key===key)return link?.type?.outward;if(link?.inwardIssue?.key===key)return link?.type?.inward;return null}
export function verifyDeclaredDependencies(metadata,issues){
  const errors=[],warnings=[];
  for(const d of metadata.dependencies??[]){
    if(!AF.test(d.reference??"")){
      if(REVIEW.has(d.blockingStage))errors.push(`${d.ticket} has an external dependency that cannot be independently verified for the ${d.blockingStage} stage.`);
      else if(LATER.has(d.blockingStage))warnings.push(`${d.ticket} retains an external ${d.blockingStage} limitation.`);
      continue;
    }
    const raw=issues.get(d.ticket)?.fields?.issuelinks,links=Array.isArray(raw)?raw:[];
    const linked=links.some((link)=>relation(link,d.reference)?.toLowerCase()===d.relationship.toLowerCase());
    if(!linked){errors.push(`${d.ticket} does not have the declared native Jira relationship to ${d.reference}.`);continue}
    const other=issues.get(d.reference);
    if(!other)errors.push(`Referenced Jira issue ${d.reference} was not verified.`);
    else if(!done(other)&&REVIEW.has(d.blockingStage))errors.push(`${d.ticket} remains blocked at ${d.blockingStage} by unresolved ${d.reference}.`);
    else if(!done(other)&&LATER.has(d.blockingStage))warnings.push(`${d.ticket} retains a ${d.blockingStage} limitation on unresolved ${d.reference}.`);
  }
  return{errors,warnings};
}
async function comments(api,key){
  const all=[];let startAt=0;
  for(let page=0;page<100;page+=1){
    const r=await api.jira(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
    const current=Array.isArray(r.comments)?r.comments:[];all.push(...current);
    if(all.length>=Number(r.total??all.length)||current.length===0)return all;
    startAt+=current.length;
  }
  throw new Error(`Jira comments for ${key} exceeded the pagination limit.`);
}
async function issue(api,key){
  const value=await api.jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,issuelinks`);
  if(value?.key!==key||!record(value.fields))throw new Error(`Jira issue ${key} could not be verified.`);
  return value;
}
function commentUrl(metadata,key){return metadata.readyEvidence?.jiraComments?.find((v)=>{try{return new URL(v).pathname===`/browse/${key}`}catch{return false}})}
async function commentError(api,key,metadata,marker,serviceId){
  const id=commentId(commentUrl(metadata,key),key);
  if(!id)return `${key} does not provide a valid focused Jira comment URL.`;
  const comment=(await comments(api,key)).find((v)=>String(v.id)===id);
  if(!comment)return `${key} ready evidence points to a Jira comment that was not found.`;
  if(comment.author?.accountId!==serviceId)return `${key} ready evidence was not authored by the configured Jira service account.`;
  if(!flattenAdf(comment.body).includes(marker))return `${key} ready evidence is stale or has a mismatched delivery marker.`;
  return null;
}
function prNumber(run){
  const numbers=[...new Set((Array.isArray(run.pull_requests)?run.pull_requests:[]).map((v)=>v?.number).filter((v)=>Number.isInteger(v)&&v>0))];
  if(numbers.length!==1)throw new Error("The CI workflow run must identify exactly one pull request.");
  return numbers[0];
}
function assertRun(run,id){
  if(String(run.id)!==String(id)||run.name!=="CI"||run.path!==".github/workflows/ci.yml"||run.event!=="pull_request"||run.status!=="completed"||run.conclusion!=="success")
    throw new Error("The authoritative pull-request CI workflow has not succeeded.");
}
function assertPr(pr,run,number){
  if(pr.number!==number||pr.state!=="open"||pr.draft!==false||!/^[0-9a-f]{40}$/i.test(pr.head?.sha??"")||pr.head.sha!==run.head_sha)
    throw new Error("The pull request is closed, draft, stale, or does not match the CI head.");
}
export async function resolveCurrentCiRunId(api,repository,event){
  const workflowId=event?.workflow_run?.id;
  if(Number.isInteger(workflowId)&&workflowId>0)return workflowId;
  const number=event?.pull_request?.number;
  if(!Number.isInteger(number)||number<1)throw new Error("GitHub event does not identify a pull request.");
  const pr=await api.github(`/repos/${repository}/pulls/${number}`);
  if(pr.number!==number||!/^[0-9a-f]{40}$/i.test(pr.head?.sha??"")){
    throw new Error("The current pull request head could not be verified.");
  }
  const runs=await api.github(
    `/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&head_sha=${pr.head.sha}&per_page=20`
  );
  const match=(Array.isArray(runs.workflow_runs)?runs.workflow_runs:[]).find(
    (run)=>run.conclusion==="success"&&(run.pull_requests??[]).some((candidate)=>candidate?.number===number)
  );
  if(!Number.isInteger(match?.id))throw new Error("No successful CI workflow run exists for the current pull request head.");
  return match.id;
}export async function verifyJiraHandoff({repository,runId,serviceAccountId,api}){
  if(repository!==REPO)throw new Error("This verifier is restricted to FutureUnicorn/AI-Filter.");
  need(serviceAccountId,"JIRA_SERVICE_ACCOUNT_ID");
  const run=await api.github(`/repos/${repository}/actions/runs/${runId}`);assertRun(run,runId);
  const number=prNumber(run),pr=await api.github(`/repos/${repository}/pulls/${number}`);assertPr(pr,run,number);
  const jobs=await api.github(`/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  const requiredJob=(Array.isArray(jobs.jobs)?jobs.jobs:[]).find((v)=>v.name==="CI / Required");
  if(requiredJob?.status!=="completed"||requiredJob?.conclusion!=="success")throw new Error("CI / Required has not succeeded for the current head.");
  const context={prNumber:number,title:pr.title,body:pr.body??"",base:pr.base?.ref,headSha:pr.head.sha,isDraft:pr.draft};
  const result=validateDeliveryMetadata(context.body,context);
  if(!result.ok)return{...result,warnings:[],repository,prNumber:number,headSha:pr.head.sha};
  const metadata=extractStructuredMetadata(context.body);
  if(metadata.readyEvidence.ciUrl!==run.html_url)result.errors.push("readyEvidence.ciUrl does not identify the authoritative CI run.");
  const keys=new Set(result.issueKeys);
  for(const d of metadata.dependencies)if(AF.test(d.reference??""))keys.add(d.reference);
  const issues=new Map();for(const key of [...keys].sort())issues.set(key,await issue(api,key));
  const marker=readyMarker(repository,number,pr.head.sha);
  for(const key of result.issueKeys){const error=await commentError(api,key,metadata,marker,serviceAccountId);if(error)result.errors.push(error)}
  const dependencies=verifyDeclaredDependencies(metadata,issues);result.errors.push(...dependencies.errors);
  return{ok:result.errors.length===0,errors:result.errors,warnings:dependencies.warnings,repository,prNumber:number,headSha:pr.head.sha};
}
function summary(result){
  const lines=[result.ok?"Trusted Jira ready evidence matches the current PR head.":"Trusted Jira ready evidence is incomplete or stale."];
  for(const e of result.errors.slice(0,20))lines.push(`- ${e}`);
  for(const w of result.warnings.slice(0,20))lines.push(`- Limitation: ${w}`);
  return lines.join("\n").slice(0,60000);
}
export async function publishReadyCheck(api,result){
  if(!/^[0-9a-f]{40}$/i.test(result.headSha??""))throw new Error("Cannot publish Jira readiness without a verified head SHA.");
  await api.github(`/repos/${result.repository}/check-runs`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
    name:"Jira Handoff / Ready",head_sha:result.headSha,status:"completed",conclusion:result.ok?"success":"failure",
    output:{title:result.ok?"Jira handoff verified":"Jira handoff needs attention",summary:summary(result)}
  })});
}
async function main(){
  let api,result,event={};
  try{
    const path=need(process.env.GITHUB_EVENT_PATH,"GITHUB_EVENT_PATH");event=JSON.parse(fs.readFileSync(path,"utf8"));
    const repository=need(process.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY");
    api=createApiClient({jiraBaseUrl:process.env.JIRA_BASE_URL,jiraEmail:process.env.JIRA_EMAIL,jiraToken:process.env.JIRA_API_TOKEN,githubToken:process.env.GITHUB_TOKEN,githubApiUrl:process.env.GITHUB_API_URL});
    const runId=await resolveCurrentCiRunId(api,repository,event);
    result=await verifyJiraHandoff({repository,runId,serviceAccountId:process.env.JIRA_SERVICE_ACCOUNT_ID,api});
  }catch(error){
    result={ok:false,errors:[error instanceof Error?error.message:"Verification failed."],warnings:[],repository:process.env.GITHUB_REPOSITORY,prNumber:null,headSha:event?.workflow_run?.head_sha??event?.pull_request?.head?.sha};
  }
  if(api)try{await publishReadyCheck(api,result)}catch(error){process.stderr.write(`Jira handoff verification could not publish its result: ${error instanceof Error?error.message:"Check publication failed."}\n`);process.exitCode=1;return}
  process.stdout.write(`${summary(result)}\n`);process.exitCode=result.ok?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
