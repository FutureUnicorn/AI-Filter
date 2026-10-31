#!/usr/bin/env node
// AF-DELIVERY-1.0 read-only GitHub-Jira reconciliation.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { extractStructuredMetadata, validateDeliveryMetadata } from "./validate-delivery-metadata.mjs";
import { createApiClient, flattenAdf, verifyDeclaredDependencies } from "./verify-jira-handoff.mjs";
import { mergedMarker } from "./sync-jira-delivery-comment.mjs";

const REPO="FutureUnicorn/AI-Filter", BASES=["develop","main"];
function need(value,name){if(typeof value!=="string"||!value.trim())throw new Error(`Missing required configuration: ${name}.`);return value}
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
async function mergedPullRequests(api,repository,since){
  const result=[];
  for(const base of BASES){
    for(let page=1;page<=10;page+=1){
      const batch=await api.github(`/repos/${repository}/pulls?state=closed&base=${base}&sort=updated&direction=desc&per_page=100&page=${page}`);
      if(!Array.isArray(batch))throw new Error("GitHub pull request list was invalid.");
      for(const summary of batch){
        if(summary.merged_at&&Date.parse(summary.merged_at)>=since.getTime()){
          const pr=await api.github(`/repos/${repository}/pulls/${summary.number}`);
          if(pr.merged_at&&pr.base?.ref===base&&pr.merge_commit_sha)result.push(pr);
        }
      }
      if(batch.length<100||batch.every((pr)=>Date.parse(pr.updated_at??0)<since.getTime()))break;
    }
  }
  return result.sort((left,right)=>left.number-right.number);
}
async function targetCi(api,repository,pr){
  const runs=await api.github(
    `/repos/${repository}/actions/workflows/ci.yml/runs?event=push&status=completed&head_sha=${pr.merge_commit_sha}&per_page=20`
  );
  return(Array.isArray(runs.workflow_runs)?runs.workflow_runs:[]).find(
    (run)=>run.conclusion==="success"&&run.head_sha===pr.merge_commit_sha&&run.head_branch===pr.base.ref
  )??null;
}
function resultRecord(pr,key,status,proposal,evidence=[],confidence="proven"){
  return{prNumber:pr.number,ticket:key,base:pr.base.ref,headSha:pr.head.sha,mergeSha:pr.merge_commit_sha,status,confidence,evidence,proposal};
}
export async function reconcileDelivery({repository,lookbackDays,serviceAccountId,api,now=new Date()}){
  if(repository!==REPO)throw new Error("Reconciliation is restricted to FutureUnicorn/AI-Filter.");
  need(serviceAccountId,"JIRA_SERVICE_ACCOUNT_ID");
  if(!Number.isInteger(lookbackDays)||lookbackDays<1||lookbackDays>90)throw new Error("lookbackDays must be an integer from 1 to 90.");
  const since=new Date(now.getTime()-lookbackDays*86400000);
  const prs=await mergedPullRequests(api,repository,since);
  const records=[];
  for(const pr of prs){
    const context={prNumber:pr.number,title:pr.title,body:pr.body??"",base:pr.base.ref,headSha:pr.head.sha,isDraft:false};
    const validation=validateDeliveryMetadata(context.body,context);
    if(!validation.ok){
      records.push(resultRecord(
        pr,null,"invalid-metadata",
        "Review the merged PR metadata and prepare a ticket-by-ticket evidence correction; do not transition Jira automatically.",
        [pr.html_url],"proven"
      ));
      continue;
    }
    const metadata=extractStructuredMetadata(context.body);
    const ci=await targetCi(api,repository,pr);
    if(!ci){
      for(const key of validation.issueKeys)records.push(resultRecord(
        pr,key,"missing-target-ci",
        "Investigate or rerun CI for the exact merge revision before adding delivery evidence.",
        [pr.html_url],"proven"
      ));
      continue;
    }
    for(const key of validation.issueKeys){
      try{
        const issues=new Map();
        const issue=await api.jira(`/rest/api/3/issue/${key}?fields=status,issuelinks`);
        if(issue?.key!==key)throw new Error("Jira issue identity mismatch.");
        issues.set(key,issue);
        const ticketDependencies=metadata.dependencies.filter((dependency)=>dependency.ticket===key);
        for(const dependency of ticketDependencies){
          if(/^AF-\d+$/.test(dependency.reference)&&!issues.has(dependency.reference)){
            const referenced=await api.jira(`/rest/api/3/issue/${dependency.reference}?fields=status,issuelinks`);
            if(referenced?.key!==dependency.reference)throw new Error("Referenced Jira issue identity mismatch.");
            issues.set(dependency.reference,referenced);
          }
        }
        const dependencyState=verifyDeclaredDependencies({dependencies:ticketDependencies},issues);
        const all=await comments(api,key);
        const exact=mergedMarker({
          repository,prNumber:pr.number,headSha:pr.head.sha,mergeSha:pr.merge_commit_sha,base:pr.base.ref
        });
        const prefix=`[AF-DELIVERY v1 stage=merged repo=${repository} pr=${pr.number} head=`;
        const owned=all.filter((comment)=>comment.author?.accountId===serviceAccountId&&flattenAdf(comment.body).includes(prefix));
        const matching=owned.filter((comment)=>flattenAdf(comment.body).includes(exact));
        if(matching.length===1){
          const commentUrl=`https://hemnaathusa.atlassian.net/browse/${key}?focusedCommentId=${matching[0].id}`;
          if(dependencyState.errors.length){
            records.push(resultRecord(
              pr,key,"dependency-drift",
              "Review the native Jira links and unresolved review or merge blockers before proposing a status change.",
              [pr.html_url,ci.html_url,commentUrl]
            ));
          }else if(dependencyState.warnings.length){
            records.push(resultRecord(
              pr,key,"verified-with-limitations",
              "Delivery evidence matches, but deployment or Done-stage limitations remain for human follow-up.",
              [pr.html_url,ci.html_url,commentUrl]
            ));
          }else{
            records.push(resultRecord(
              pr,key,"verified",
              "No automated correction proposed. Human owners may evaluate Jira status against acceptance and operational evidence.",
              [pr.html_url,ci.html_url,commentUrl]
            ));
          }
        }else if(matching.length>1||owned.length>1){
          records.push(resultRecord(
            pr,key,"duplicate-merge-evidence",
            "A human should inspect duplicate service-account comments and approve one scoped cleanup.",
            [pr.html_url,ci.html_url]
          ));
        }else if(owned.length===1){
          records.push(resultRecord(
            pr,key,"stale-merge-evidence",
            "Replay the protected post-merge sync for this PR after confirming the exact merge and CI revisions.",
            [pr.html_url,ci.html_url]
          ));
        }else{
          records.push(resultRecord(
            pr,key,"missing-merge-evidence",
            "Replay the protected post-merge sync for this PR; do not infer Done from the merge alone.",
            [pr.html_url,ci.html_url]
          ));
        }
      }catch{
        records.push(resultRecord(
          pr,key,"unknown-jira",
          "Retry reconciliation after Jira access recovers; make no status correction from unavailable evidence.",
          [pr.html_url,ci.html_url],"unknown"
        ));
      }
    }
  }
  return{generatedAt:now.toISOString(),repository,lookbackDays,since:since.toISOString(),pullRequests:prs.length,records};
}
export function renderReconciliationMarkdown(report){
  const counts=new Map();
  for(const record of report.records)counts.set(record.status,(counts.get(record.status)??0)+1);
  const lines=[
    "# GitHub-Jira delivery reconciliation",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.repository}`,
    `Lookback: ${report.lookbackDays} days`,
    `Merged pull requests inspected: ${report.pullRequests}`,
    "",
    "## Summary",
    ""
  ];
  if(counts.size===0)lines.push("- No merged pull requests with policy metadata were found.");
  for(const [status,count] of [...counts].sort())lines.push(`- ${status}: ${count}`);
  lines.push("","## Evidence-backed proposals","");
  for(const record of report.records){
    lines.push(
      `- PR #${record.prNumber} / ${record.ticket??"no verified ticket"}: **${record.status}** (${record.confidence}). ${record.proposal}`
    );
    for(const evidence of record.evidence)lines.push(`  - ${evidence}`);
  }
  lines.push("","No Jira comments or statuses were changed by this report.");
  return lines.join("\n")+"\n";
}
async function main(){
  try{
    const lookback=Number(process.env.RECONCILIATION_LOOKBACK_DAYS??"14");
    const api=createApiClient({jiraBaseUrl:process.env.JIRA_BASE_URL,jiraEmail:process.env.JIRA_EMAIL,jiraToken:process.env.JIRA_API_TOKEN,githubToken:process.env.GITHUB_TOKEN,githubApiUrl:process.env.GITHUB_API_URL});
    const report=await reconcileDelivery({repository:need(process.env.GITHUB_REPOSITORY,"GITHUB_REPOSITORY"),lookbackDays:lookback,serviceAccountId:process.env.JIRA_SERVICE_ACCOUNT_ID,api});
    const markdown=renderReconciliationMarkdown(report);
    fs.writeFileSync("delivery-reconciliation.json",JSON.stringify(report,null,2)+"\n");
    fs.writeFileSync("delivery-reconciliation.md",markdown);
    if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,markdown);
    process.stdout.write(`Reconciled ${report.pullRequests} merged pull requests; ${report.records.length} ticket records.\n`);
  }catch(error){
    process.stderr.write(`${error instanceof Error?error.message:"Reconciliation failed."}\n`);
    process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
