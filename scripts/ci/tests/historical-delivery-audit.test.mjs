import assert from "node:assert/strict";
import test from "node:test";
import {
  auditHistoricalDelivery,
  renderHistoricalAuditMarkdown,
  validateHistoricalAuditManifest
} from "../audit-historical-delivery.mjs";

const repository = "FutureUnicorn/AI-Filter";
const shas = {
  af103: "e26fffa65f1d80e086b53a3062ae2e7b6c86c1ae",
  af67: "588dc8a4b2cbe67238710c7b4eed6af6a5cf0000",
  af106: "bbe7aafd4a4ce3261263ca46ac9d267e43fd071d",
  stacked: "a06dc4c5cc8509dd81784ac8c5bd134401387346"
};

function candidate(ticket, values = {}) {
  return {
    ticket,
    kind: "delivery",
    prNumbers: [],
    acceptanceStatus: "unverified",
    acceptanceSummary: "Evidence requires review.",
    evidence: ["reviewed source"],
    dependencies: [],
    ...values
  };
}
function manifest(candidates) {
  return {
    schemaVersion: 1,
    policyVersion: "AF-DELIVERY-1.0",
    snapshotDate: "2026-10-31",
    repository,
    jiraProject: "AF",
    targetBranches: ["develop", "main"],
    candidates
  };
}
function jiraIssue(key, status, links = []) {
  return {
    key,
    fields: {
      summary: `Summary for ${key}`,
      status: { name: status, statusCategory: { key: status === "Done" ? "done" : "indeterminate" } },
      assignee: { displayName: "Ticket Owner" },
      issuelinks: links
    }
  };
}
function pr(number, sha, base = "develop", merged = true) {
  return {
    number,
    state: merged ? "closed" : "open",
    title: `PR ${number}`,
    html_url: `https://github.com/FutureUnicorn/AI-Filter/pull/${number}`,
    merged_at: merged ? "2026-10-24T10:26:55Z" : null,
    merge_commit_sha: merged ? sha : null,
    base: { ref: base },
    head: { sha: String(number).padStart(40, "0") }
  };
}
function apiFixture({ issues, prs, ciShas = [] }) {
  return {
    jira: async (path) => {
      const match = path.match(/\/issue\/(AF-\d+)/u);
      const value = issues[match?.[1]];
      if (!value) throw new Error("missing Jira fixture");
      return value;
    },
    github: async (path) => {
      const prMatch = path.match(/\/pulls\/(\d+)$/u);
      if (prMatch) return prs[Number(prMatch[1])];
      if (path.includes("/actions/workflows/ci.yml/runs?")) {
        const sha = new URL(`https://api.github.test${path}`).searchParams.get("head_sha");
        return {
          workflow_runs: ciShas.includes(sha)
            ? [{ id: Number.parseInt(sha.slice(0, 6), 16), head_sha: sha, head_branch: "develop", conclusion: "success", html_url: `https://github.com/actions/runs/${sha.slice(0, 8)}` }]
            : []
        };
      }
      if (/\/actions\/runs\/\d+\/jobs/u.test(path)) {
        return { jobs: [{ name: "CI / Required", status: "completed", conclusion: "success" }] };
      }
      throw new Error(`unexpected GitHub path: ${path}`);
    }
  };
}

test("historical audit separates direct delivery, stacked work, dependencies, and operational limits", async () => {
  const af102Link = {
    type: { inward: "is blocked by", outward: "blocks" },
    inwardIssue: { key: "AF-102" }
  };
  const input = manifest([
    candidate("AF-103", { prNumbers: [94], acceptanceStatus: "met", acceptanceSummary: "Health diagnostics are verified." }),
    candidate("AF-104", {
      prNumbers: [94],
      acceptanceStatus: "met",
      acceptanceSummary: "Budget emitter is verified.",
      dependencies: [{ ticket: "AF-102", relationship: "is blocked by", source: "ticket description" }]
    }),
    candidate("AF-52", { prNumbers: [61], acceptanceSummary: "Stack must land first." }),
    candidate("AF-67", {
      kind: "operational",
      prNumbers: [89],
      acceptanceStatus: "partial",
      acceptanceSummary: "Live alert drills remain.",
      dependencies: [{ ticket: "AF-102", relationship: "is blocked by", source: "native link" }]
    }),
    candidate("AF-106", { prNumbers: [95], acceptanceStatus: "met", acceptanceSummary: "Delivery is complete." })
  ]);
  const api = apiFixture({
    issues: {
      "AF-103": jiraIssue("AF-103", "In Review"),
      "AF-104": jiraIssue("AF-104", "In Review"),
      "AF-52": jiraIssue("AF-52", "In Review"),
      "AF-67": jiraIssue("AF-67", "In Progress", [af102Link]),
      "AF-102": jiraIssue("AF-102", "Done"),
      "AF-106": jiraIssue("AF-106", "Done")
    },
    prs: {
      94: pr(94, shas.af103),
      61: pr(61, shas.stacked, "feature/AF-51-named-human-decision-recording"),
      89: pr(89, shas.af67),
      95: pr(95, shas.af106)
    },
    ciShas: [shas.af103, shas.af67, shas.af106]
  });

  const report = await auditHistoricalDelivery({ manifest: input, api, now: new Date("2026-10-31T12:00:00Z") });
  assert.equal(report.mutationMode, "read-only");
  const byKey = new Map(report.records.map((record) => [record.ticket, record]));
  assert.equal(byKey.get("AF-103").deliveryStatus, "delivered-to-target");
  assert.match(byKey.get("AF-103").proposedAction, /may move this ticket to Done/u);
  assert.deepEqual(byKey.get("AF-104").dependencyDrift, ["AF-102"]);
  assert.match(byKey.get("AF-104").proposedAction, /native Jira dependency link/u);
  assert.equal(byKey.get("AF-52").deliveryStatus, "stacked-not-delivered");
  assert.match(byKey.get("AF-52").proposedAction, /not delivered/u);
  assert.equal(byKey.get("AF-67").dependencies[0].linked, true);
  assert.match(byKey.get("AF-67").proposedAction, /incomplete or unverified/u);
  assert.equal(byKey.get("AF-106").jiraStatus, "Done");
  assert.match(byKey.get("AF-106").proposedAction, /No status change/u);
});

test("a successful workflow without the exact Required job is not target CI evidence", async () => {
  const input = manifest([
    candidate("AF-103", { prNumbers: [94], acceptanceStatus: "met", acceptanceSummary: "Verified." })
  ]);
  const api = apiFixture({
    issues: { "AF-103": jiraIssue("AF-103", "In Review") },
    prs: { 94: pr(94, shas.af103) },
    ciShas: []
  });
  const report = await auditHistoricalDelivery({ manifest: input, api });
  assert.equal(report.records[0].deliveryStatus, "missing-target-ci");
  assert.match(report.records[0].proposedAction, /exact target-branch merge revision/u);
});

test("API outages produce unknown evidence and never a completion proposal", async () => {
  const input = manifest([candidate("AF-103")]);
  const report = await auditHistoricalDelivery({
    manifest: input,
    api: { jira: async () => { throw new Error("unavailable"); }, github: async () => { throw new Error("unused"); } }
  });
  assert.equal(report.records[0].deliveryStatus, "unknown");
  assert.equal(report.records[0].confidence, "unknown");
  assert.match(report.records[0].proposedAction, /No Jira change/u);
});

test("manifest validation rejects duplicate tickets and unsupported repositories", () => {
  assert.throws(
    () => validateHistoricalAuditManifest({ ...manifest([candidate("AF-1")]), repository: "attacker/repo" }),
    /restricted/u
  );
  assert.throws(
    () => validateHistoricalAuditManifest(manifest([candidate("AF-1"), candidate("AF-1")])),
    /duplicated/u
  );
});

test("markdown is traceable and explicitly read-only", async () => {
  const input = manifest([candidate("AF-1", { kind: "aggregate", acceptanceStatus: "not-applicable", acceptanceSummary: "Review children." })]);
  const api = apiFixture({ issues: { "AF-1": jiraIssue("AF-1", "In Review") }, prs: {} });
  const report = await auditHistoricalDelivery({ manifest: input, api });
  const markdown = renderHistoricalAuditMarkdown(report);
  assert.match(markdown, /AF-1/u);
  assert.match(markdown, /aggregate-no-direct-pr/u);
  assert.match(markdown, /No Jira comments, links, fields, sprint state, or statuses were changed/u);
});