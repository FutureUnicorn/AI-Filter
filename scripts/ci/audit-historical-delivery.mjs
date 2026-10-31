#!/usr/bin/env node
// AF-DELIVERY-1.0 read-only historical Jira/GitHub audit.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createApiClient } from "./verify-jira-handoff.mjs";

const REPOSITORY = "FutureUnicorn/AI-Filter";
const JIRA_ORIGIN = "https://hemnaathusa.atlassian.net";
const TICKET = /^AF-\d+$/u;
const SHA = /^[0-9a-f]{40}$/iu;
const KINDS = new Set(["delivery", "aggregate", "operational"]);
const ACCEPTANCE = new Set(["met", "partial", "unverified", "not-applicable"]);

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  return value;
}
function issueRelation(link, otherKey) {
  if (link?.inwardIssue?.key === otherKey) return link?.type?.inward ?? null;
  if (link?.outwardIssue?.key === otherKey) return link?.type?.outward ?? null;
  return null;
}
function urlForTicket(key) {
  return `${JIRA_ORIGIN}/browse/${encodeURIComponent(key)}`;
}
function unique(values) {
  return [...new Set(values)];
}
function safeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function validateHistoricalAuditManifest(manifest) {
  if (!object(manifest) || manifest.schemaVersion !== 1) throw new Error("Historical audit manifest schemaVersion must be 1.");
  if (manifest.policyVersion !== "AF-DELIVERY-1.0") throw new Error("Historical audit manifest policyVersion is unsupported.");
  if (manifest.repository !== REPOSITORY) throw new Error(`Historical audit is restricted to ${REPOSITORY}.`);
  if (!Array.isArray(manifest.targetBranches) || manifest.targetBranches.length === 0) {
    throw new Error("Historical audit targetBranches must not be empty.");
  }
  if (!Array.isArray(manifest.candidates) || manifest.candidates.length === 0) {
    throw new Error("Historical audit candidates must not be empty.");
  }
  const seen = new Set();
  for (const [index, candidate] of manifest.candidates.entries()) {
    const prefix = `candidates[${index}]`;
    if (!object(candidate) || !TICKET.test(candidate.ticket ?? "")) throw new Error(`${prefix}.ticket must be an AF key.`);
    if (seen.has(candidate.ticket)) throw new Error(`Historical audit candidate ${candidate.ticket} is duplicated.`);
    seen.add(candidate.ticket);
    if (!KINDS.has(candidate.kind)) throw new Error(`${prefix}.kind is unsupported.`);
    if (!ACCEPTANCE.has(candidate.acceptanceStatus)) throw new Error(`${prefix}.acceptanceStatus is unsupported.`);
    required(candidate.acceptanceSummary, `${prefix}.acceptanceSummary`);
    if (!Array.isArray(candidate.prNumbers) || candidate.prNumbers.some((number) => !Number.isInteger(number) || number < 1)) {
      throw new Error(`${prefix}.prNumbers must contain positive integers.`);
    }
    if (!Array.isArray(candidate.evidence) || candidate.evidence.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      throw new Error(`${prefix}.evidence must contain non-empty references.`);
    }
    if (!Array.isArray(candidate.dependencies)) throw new Error(`${prefix}.dependencies must be an array.`);
    for (const dependency of candidate.dependencies) {
      if (!TICKET.test(dependency?.ticket ?? "") || dependency.ticket === candidate.ticket) {
        throw new Error(`${prefix} has an invalid dependency ticket.`);
      }
      required(dependency.relationship, `${prefix}.dependencies.relationship`);
      required(dependency.source, `${prefix}.dependencies.source`);
    }
  }
  return manifest;
}

async function targetCi(api, repository, pullRequest) {
  const sha = pullRequest.merge_commit_sha;
  if (!SHA.test(sha ?? "")) return null;
  const runs = await api.github(
    `/repos/${repository}/actions/workflows/ci.yml/runs?event=push&status=completed&head_sha=${sha}&per_page=20`
  );
  const candidates = Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [];
  for (const run of candidates) {
    if (run.head_sha !== sha || run.head_branch !== pullRequest.base?.ref || run.conclusion !== "success") continue;
    const jobs = await api.github(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    const requiredJob = (Array.isArray(jobs.jobs) ? jobs.jobs : []).find((job) => job.name === "CI / Required");
    if (requiredJob?.status === "completed" && requiredJob?.conclusion === "success") {
      return { runId: run.id, conclusion: "success", required: "success", url: run.html_url };
    }
  }
  return null;
}

function classifyDelivery(candidate, pullRequests) {
  if (candidate.kind === "aggregate" && pullRequests.length === 0) return "aggregate-no-direct-pr";
  if (candidate.kind === "operational" && pullRequests.length === 0) return "non-pr-operational";
  const direct = pullRequests.filter((entry) => entry.directMerge);
  if (direct.length > 0) return direct.every((entry) => entry.targetCi !== null) ? "delivered-to-target" : "missing-target-ci";
  if (pullRequests.some((entry) => entry.merged && !entry.targetBase)) return "stacked-not-delivered";
  if (pullRequests.some((entry) => entry.state === "open")) return "open-not-delivered";
  return "not-delivered";
}

function proposedAction({ candidate, jiraStatus, deliveryStatus, dependencyDrift }) {
  if (deliveryStatus === "unknown") return "No Jira change. Retry after GitHub or Jira evidence is available.";
  if (dependencyDrift.length > 0) return "Review and correct the native Jira dependency link before any status transition.";
  if (deliveryStatus === "missing-target-ci") return "Keep the current Jira status until CI is verified on the exact target-branch merge revision.";
  if (["stacked-not-delivered", "open-not-delivered", "not-delivered"].includes(deliveryStatus)) {
    return "Keep the ticket open; the referenced work is not delivered to develop or main.";
  }
  if (["aggregate-no-direct-pr", "non-pr-operational"].includes(deliveryStatus)) {
    return "Keep human control; review child-ticket or operational evidence rather than inferring completion from code merges.";
  }
  if (candidate.acceptanceStatus === "met") {
    return jiraStatus === "Done"
      ? "No status change proposed; retain the verified completed record."
      : "Human owner may move this ticket to Done after reviewing the verified merge, CI, acceptance, and dependency evidence.";
  }
  return "Keep the current Jira status; acceptance or operational evidence remains incomplete or unverified.";
}

export async function auditHistoricalDelivery({ manifest, api, now = new Date() }) {
  validateHistoricalAuditManifest(manifest);
  const issueCache = new Map();
  const prCache = new Map();
  async function issue(key) {
    if (!issueCache.has(key)) {
      issueCache.set(key, api.jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,issuelinks`));
    }
    const value = await issueCache.get(key);
    if (value?.key !== key || !object(value.fields)) throw new Error(`Jira issue ${key} could not be verified.`);
    return value;
  }
  async function pull(number) {
    if (!prCache.has(number)) prCache.set(number, api.github(`/repos/${manifest.repository}/pulls/${number}`));
    const value = await prCache.get(number);
    if (value?.number !== number) throw new Error(`GitHub pull request #${number} could not be verified.`);
    return value;
  }

  const records = [];
  for (const candidate of manifest.candidates) {
    try {
      const jira = await issue(candidate.ticket);
      const pullRequests = [];
      for (const number of candidate.prNumbers) {
        const pr = await pull(number);
        const targetBase = manifest.targetBranches.includes(pr.base?.ref);
        const merged = typeof pr.merged_at === "string" && SHA.test(pr.merge_commit_sha ?? "");
        const directMerge = merged && targetBase;
        pullRequests.push({
          number,
          state: pr.state,
          title: pr.title,
          url: pr.html_url,
          base: pr.base?.ref ?? null,
          headSha: pr.head?.sha ?? null,
          mergeSha: merged ? pr.merge_commit_sha : null,
          merged,
          targetBase,
          directMerge,
          targetCi: directMerge ? await targetCi(api, manifest.repository, pr) : null
        });
      }
      const dependencyResults = [];
      const dependencyDrift = [];
      for (const expected of candidate.dependencies) {
        const referenced = await issue(expected.ticket);
        const links = Array.isArray(jira.fields.issuelinks) ? jira.fields.issuelinks : [];
        const actual = links.map((link) => issueRelation(link, expected.ticket)).find(Boolean) ?? null;
        const linked = actual?.toLowerCase() === expected.relationship.toLowerCase();
        if (!linked) dependencyDrift.push(expected.ticket);
        dependencyResults.push({
          ticket: expected.ticket,
          expectedRelationship: expected.relationship,
          actualRelationship: actual,
          linked,
          status: referenced.fields.status?.name ?? "Unknown",
          source: expected.source,
          url: urlForTicket(expected.ticket)
        });
      }
      const deliveryStatus = classifyDelivery(candidate, pullRequests);
      const jiraStatus = jira.fields.status?.name ?? "Unknown";
      const sourceUrls = unique([
        urlForTicket(candidate.ticket),
        ...pullRequests.map((entry) => entry.url).filter(Boolean),
        ...pullRequests.map((entry) => entry.targetCi?.url).filter(Boolean),
        ...dependencyResults.map((entry) => entry.url)
      ]);
      records.push({
        ticket: candidate.ticket,
        summary: jira.fields.summary ?? "",
        owner: jira.fields.assignee?.displayName ?? "Unassigned",
        jiraStatus,
        kind: candidate.kind,
        deliveryStatus,
        pullRequests,
        acceptanceStatus: candidate.acceptanceStatus,
        acceptanceSummary: candidate.acceptanceSummary,
        acceptanceEvidence: candidate.evidence,
        dependencies: dependencyResults,
        dependencyDrift,
        confidence: candidate.acceptanceStatus === "unverified" ? "medium" : "high",
        proposedAction: proposedAction({ candidate, jiraStatus, deliveryStatus, dependencyDrift }),
        sourceUrls
      });
    } catch {
      records.push({
        ticket: candidate.ticket,
        summary: "",
        owner: "Unknown",
        jiraStatus: "Unknown",
        kind: candidate.kind,
        deliveryStatus: "unknown",
        pullRequests: [],
        acceptanceStatus: candidate.acceptanceStatus,
        acceptanceSummary: candidate.acceptanceSummary,
        acceptanceEvidence: candidate.evidence,
        dependencies: [],
        dependencyDrift: [],
        confidence: "unknown",
        proposedAction: "No Jira change. Retry after GitHub or Jira evidence is available.",
        sourceUrls: [urlForTicket(candidate.ticket)]
      });
    }
  }
  return {
    schemaVersion: 1,
    policyVersion: manifest.policyVersion,
    generatedAt: now.toISOString(),
    snapshotDate: manifest.snapshotDate,
    repository: manifest.repository,
    targetBranches: manifest.targetBranches,
    mutationMode: "read-only",
    records
  };
}

export function renderHistoricalAuditMarkdown(report) {
  const counts = new Map();
  for (const record of report.records) counts.set(record.deliveryStatus, (counts.get(record.deliveryStatus) ?? 0) + 1);
  const lines = [
    "# Historical GitHub-Jira delivery audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.repository}`,
    `Mode: ${report.mutationMode}`,
    "",
    "## Delivery summary",
    ""
  ];
  for (const [status, count] of [...counts].sort()) lines.push(`- ${status}: ${count}`);
  lines.push(
    "",
    "## Evidence-backed correction proposals",
    "",
    "| Ticket | Jira status | Delivery | PR / target / merge | CI | Acceptance | Dependencies | Confidence | Proposed action | Owner |",
    "|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const record of report.records) {
    const prs = record.pullRequests.length === 0
      ? "none"
      : record.pullRequests.map((pr) => `#${pr.number} / ${pr.base ?? "unknown"} / ${pr.mergeSha ?? "unmerged"}`).join("; ");
    const ci = record.pullRequests.some((pr) => pr.targetCi?.required === "success") ? "CI / Required: success" : "none verified";
    const dependencies = record.dependencies.length === 0
      ? "none"
      : record.dependencies.map((dependency) => `${dependency.ticket}: ${dependency.linked ? "linked" : "missing link"}, ${dependency.status}`).join("; ");
    lines.push(`| ${[
      record.ticket,
      record.jiraStatus,
      record.deliveryStatus,
      prs,
      ci,
      `${record.acceptanceStatus}: ${record.acceptanceSummary}`,
      dependencies,
      record.confidence,
      record.proposedAction,
      record.owner
    ].map(safeCell).join(" | ")} |`);
  }
  lines.push("", "No Jira comments, links, fields, sprint state, or statuses were changed by this audit.", "");
  return lines.join("\n");
}

async function main() {
  try {
    const manifestPath = process.env.HISTORICAL_AUDIT_MANIFEST ?? "config/delivery/historical-audit-candidates.json";
    const manifest = validateHistoricalAuditManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const api = createApiClient({
      jiraBaseUrl: process.env.JIRA_BASE_URL,
      jiraEmail: process.env.JIRA_EMAIL,
      jiraToken: process.env.JIRA_API_TOKEN,
      githubToken: process.env.GITHUB_TOKEN,
      githubApiUrl: process.env.GITHUB_API_URL
    });
    const report = await auditHistoricalDelivery({ manifest, api });
    const markdown = renderHistoricalAuditMarkdown(report);
    fs.writeFileSync("historical-delivery-audit.json", `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync("historical-delivery-audit.md", markdown);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    process.stdout.write(`Audited ${report.records.length} Jira candidates in read-only mode.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Historical audit failed."}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
