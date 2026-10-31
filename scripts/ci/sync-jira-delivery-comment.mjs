#!/usr/bin/env node
// AF-DELIVERY-1.0 trusted post-merge evidence upsert. No Jira transitions.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { extractStructuredMetadata, validateDeliveryMetadata } from "./validate-delivery-metadata.mjs";
import { createApiClient, flattenAdf, readyMarker, verifyDeclaredDependencies } from "./verify-jira-handoff.mjs";

const REPO="FutureUnicorn/AI-Filter", AF=/^AF-\d+$/;
const BASES=new Set(["develop","main"]);
function need(value,name){if(typeof value!=="string"||!value.trim())throw new Error(`Missing required configuration: ${name}.`);return value}
export const mergedMarker=({repository,prNumber,headSha,mergeSha,base}) =>
  `[AF-DELIVERY v1 stage=merged repo=${repository} pr=${prNumber} head=${headSha} merge=${mergeSha} base=${base}]`;
const commentAdf=(text)=>({type:"doc",version:1,content:text.split("\n").map((line)=>({type:"paragraph",content:line?[{type:"text",text:line}]:[]}))});
const done=(issue)=>issue?.fields?.status?.statusCategory?.key==="done";

async function comments(api,key){
  const all=[];let startAt=0;
  for(let page=0;page<100;page+=1){
    const response=await api.jira(`/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
    const current=Array.isArray(response.comments)?response.comments:[];all.push(...current);
    if(all.length>=Number(response.total??all.length)||current.length===0)return all;
    startAt+=current.length;
  }
  throw new Error(`Jira comments for ${key} exceeded the pagination limit.`);
}
async function jiraIssue(api,key){
  const issue=await api.jira(`/rest/api/3/issue/${key}?fields=status,issuelinks`);
  if(issue?.key!==key||!issue.fields)throw new Error(`Jira issue ${key} could not be verified.`);
  return issue;
}
function focusedId(value,key){
  try{const url=new URL(value),id=url.searchParams.get("focusedCommentId");return url.origin==="https://hemnaathusa.atlassian.net"&&url.pathname===`/browse/${key}`&&/^\d+$/.test(id??"")?id:null}catch{return null}
}
function counts(ticket){
  const values=new Map(["Met","Unmet","Deferred","Not verified"].map((status)=>[status,0]));
  for(const criterion of ticket.acceptance)values.set(criterion.status,values.get(criterion.status)+1);
  return [...values].map(([status,count])=>`${status} ${count}`).join("; ");
}
export function mergedCommentText({metadata,ticket,repository,prNumber,headSha,mergeSha,base,targetCiUrl,limitations,currentStatus}){
  const ticketDependencies=metadata.dependencies.filter((dependency)=>dependency.ticket===ticket.key);
  const classifications=new Map(["automated","mocked","live","manual","unverified"].map((value)=>[value,0]));
  for(const test of metadata.tests)classifications.set(test.classification,classifications.get(test.classification)+1);
  const acceptanceComplete=ticket.acceptance.every((criterion)=>criterion.status==="Met");
  const testComplete=classifications.get("unverified")===0;
  const recommendDone=acceptanceComplete&&testComplete&&limitations.length===0;
  const lines=[
    "Signal Audit code delivery has been verified on the target branch.",
    "",
    `Ticket: ${ticket.key}`,
    `Pull request: https://github.com/${repository}/pull/${prNumber}`,
    `PR head: ${headSha}`,
    `Merge revision: ${mergeSha}`,
    `Target branch: ${base}`,
    `Verified target-branch CI: ${targetCiUrl}`,
    `Current Jira status at verification: ${currentStatus}`,
    "",
    `Contributor-reported acceptance status: ${counts(ticket)}.`,
    `Verification classifications: ${[...classifications].map(([value,count])=>`${value} ${count}`).join("; ")}.`,
    `Declared dependencies for this ticket: ${ticketDependencies.length}.`
  ];
  for(const dependency of ticketDependencies){
    const reference=AF.test(dependency.reference??"")?dependency.reference:"external dependency";
    lines.push(`- ${dependency.relationship} ${reference}; blocking stage: ${dependency.blockingStage}.`);
  }
  for(const limitation of limitations)lines.push(`- Remaining limitation: ${limitation}`);
  lines.push(
    "",
    recommendDone
      ? "Recommendation: a human may evaluate moving this ticket to Done after confirming product and operational acceptance."
      : "Recommendation: keep the current Jira status until the reported gaps or limitations are resolved and a human confirms acceptance.",
    "This comment records delivery evidence only. It does not approve scope, transition Jira, or make a hiring decision.",
    "",
    mergedMarker({repository,prNumber,headSha,mergeSha,base})
  );
  return{text:lines.join("\n"),recommendDone};
}
async function authoritativeMerge(api,repository,runId){
  const run=await api.github(`/repos/${repository}/actions/runs/${runId}`);
  if(
    String(run.id)!==String(runId)||run.name!=="CI"||run.path!==".github/workflows/ci.yml"||
    run.event!=="push"||run.status!=="completed"||run.conclusion!=="success"||
    !BASES.has(run.head_branch)||!/^[0-9a-f]{40}$/i.test(run.head_sha??"")
  )throw new Error("The event is not a successful authoritative target-branch CI run.");
  const associated=await api.github(`/repos/${repository}/commits/${run.head_sha}/pulls`);
  const candidates=(Array.isArray(associated)?associated:[]).filter(
    (pr)=>pr.merged_at&&pr.merge_commit_sha===run.head_sha&&pr.base?.ref===run.head_branch
  );
  if(candidates.length!==1)throw new Error("The target revision must map to exactly one directly merged pull request.");
  const pr=await api.github(`/repos/${repository}/pulls/${candidates[0].number}`);
  if(!pr.merged_at||pr.merge_commit_sha!==run.head_sha||pr.base?.ref!==run.head_branch||pr.state!=="closed"){
    throw new Error("The associated pull request is not an authoritative direct target-branch merge.");
  }
  const jobs=await api.github(`/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  const required=(Array.isArray(jobs.jobs)?jobs.jobs:[]).find((job)=>job.name==="CI / Required");
  if(required?.status!=="completed"||required?.conclusion!=="success")throw new Error("Target-branch CI / Required did not succeed.");
  return{run,pr};
}
export async function syncMergedDelivery({repository,runId,serviceAccountId,api}){
  if(repository!==REPO)throw new Error("Post-merge sync is restricted to FutureUnicorn/AI-Filter.");
  need(serviceAccountId,"JIRA_SERVICE_ACCOUNT_ID");
  const {run,pr}=await authoritativeMerge(api,repository,runId);
  const context={prNumber:pr.number,title:pr.title,body:pr.body??"",base:pr.base.ref,headSha:pr.head.sha,isDraft:false};
  const validation=validateDeliveryMetadata(context.body,context);
  if(!validation.ok)throw new Error(`Merged PR metadata needs attention: ${validation.errors.slice(0,10).join(" | ")}`);
  const metadata=extractStructuredMetadata(context.body);
  const keys=new Set(validation.issueKeys);
  for(const dependency of metadata.dependencies)if(AF.test(dependency.reference??""))keys.add(dependency.reference);
  const issues=new Map();
  for(const key of [...keys].sort())issues.set(key,await jiraIssue(api,key));
  const dependencyResult=verifyDeclaredDependencies(metadata,issues);
  if(dependencyResult.errors.length)throw new Error(`Merged dependency verification failed: ${dependencyResult.errors.join(" | ")}`);

  const output=[];
  for(const ticket of metadata.tickets){
    const all=await comments(api,ticket.key);
    const readyUrl=metadata.readyEvidence.jiraComments.find((value)=>{try{return new URL(value).pathname===`/browse/${ticket.key}`}catch{return false}});
    const readyId=focusedId(readyUrl,ticket.key);
    const ready=all.find((comment)=>String(comment.id)===readyId);
    if(
      !ready||ready.author?.accountId!==serviceAccountId||
      !flattenAdf(ready.body).includes(readyMarker(repository,pr.number,pr.head.sha))
    )throw new Error(`${ticket.key} does not have authorized ready evidence for the merged PR head.`);

    const prefix=`[AF-DELIVERY v1 stage=merged repo=${repository} pr=${pr.number} head=`;
    const owned=all.filter((comment)=>comment.author?.accountId===serviceAccountId&&flattenAdf(comment.body).includes(prefix));
    if(owned.length>1)throw new Error(`${ticket.key} has duplicate bot-owned merged comments; human cleanup is required.`);
    const limitations=dependencyResult.warnings.filter((warning)=>warning.startsWith(ticket.key+" "));
    const rendered=mergedCommentText({
      metadata,ticket,repository,prNumber:pr.number,headSha:pr.head.sha,mergeSha:run.head_sha,
      base:run.head_branch,targetCiUrl:run.html_url,limitations,
      currentStatus:issues.get(ticket.key)?.fields?.status?.name??(done(issues.get(ticket.key))?"Done":"Unknown")
    });
    const payload={body:commentAdf(rendered.text)};
    const saved=owned.length
      ? await api.jira(`/rest/api/3/issue/${ticket.key}/comment/${owned[0].id}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(payload)})
      : await api.jira(`/rest/api/3/issue/${ticket.key}/comment`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    if(!/^\d+$/.test(String(saved?.id??"")))throw new Error(`Jira did not return a valid merged comment id for ${ticket.key}.`);
    output.push({key:ticket.key,id:String(saved.id),action:owned.length?"updated":"created",recommendDone:rendered.recommendDone});
  }
  return{prNumber:pr.number,mergeSha:run.head_sha,targetCiUrl:run.html_url,comments:output};
}
async function main(){
  try{
    const event=JSON.parse(fs.readFileSync(need(process.env.GITHUB_EVENT_PATH,"GITHUB_EVENT_PATH"),"utf8"));
    const runId=event?.workflow_run?.id;if(!Number.isInteger(runId)||runId<1)throw new Error("workflow_run id is required.");
    const api=createApiClient({jiraBaseUrl:process.env.JIRA_BASE_URL,jiraEmail:process.env.JIRA_EMAIL,jiraToken:process.env.JIRA_API_TOKEN,githubToken:process.env.GITHUB_TOKEN,githubApiUrl:process.env.GITHUB_API_URL});
    const result=await syncMergedDelivery({repository:need(process.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY"),runId,serviceAccountId:process.env.JIRA_SERVICE_ACCOUNT_ID,api});
    process.stdout.write(`Verified PR #${result.prNumber} at merge ${result.mergeSha}.\n`);
    for(const comment of result.comments)process.stdout.write(`${comment.key}: ${comment.action}; Done recommendation=${comment.recommendDone}.\n`);
  }catch(error){
    process.stderr.write(`${error instanceof Error?error.message:"Post-merge sync failed."}\n`);
    process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
