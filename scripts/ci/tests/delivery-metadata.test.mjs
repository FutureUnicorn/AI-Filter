import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  contextFromGitHubEvent,
  extractStructuredMetadata,
  renderMarkdownReport,
  validateDeliveryMetadata
} from "../validate-delivery-metadata.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(testDirectory, "../validate-delivery-metadata.mjs");
const fixture = (name) =>
  fs.readFileSync(path.join(testDirectory, "fixtures", name), "utf8").replace(/\r\n/g, "\n");
const validBody = fixture("valid-pr.md");
const invalidBody = fixture("invalid-pr.md");
const HEAD = "a".repeat(40);
const CONTEXT = {
  title: "AF-106: provider-neutral delivery evidence",
  base: "develop",
  headSha: HEAD,
  prNumber: 96,
  isDraft: true
};

function withMetadata(body, update) {
  const metadata = structuredClone(extractStructuredMetadata(body));
  update(metadata);
  const replacement = "```json\n" + JSON.stringify(metadata, null, 2) + "\n```";
  return body.replace(/```json\n[\s\S]*?\n```/, replacement);
}

test("the passing example is structurally complete", () => {
  const result = validateDeliveryMetadata(validBody, CONTEXT);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.issueKeys, ["AF-106"]);
});

test("the deliberately bad example reports actionable gaps", () => {
  const result = validateDeliveryMetadata(invalidBody, CONTEXT);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 5);
  assert.match(result.errors.join("\n"), /tickets must contain at least one AF issue/);
});

test("the acceptance vocabulary rejects Partial", () => {
  const body = withMetadata(validBody, (metadata) => {
    metadata.tickets[0].acceptance[0].status = "Partial";
  });
  assert.match(
    validateDeliveryMetadata(body, CONTEXT).errors.join("\n"),
    /must be Met, Unmet, Deferred, or Not verified/
  );
});

test("Met acceptance needs evidence", () => {
  const body = withMetadata(validBody, (metadata) => {
    metadata.tickets[0].acceptance[0].evidence = [];
  });
  assert.match(
    validateDeliveryMetadata(body, CONTEXT).errors.join("\n"),
    /cannot be Met without evidence/
  );
});

test("Deferred acceptance needs a scoped human-approved exception", () => {
  const deferred = withMetadata(validBody, (metadata) => {
    metadata.tickets[0].acceptance[0].status = "Deferred";
    metadata.tickets[0].acceptance[0].evidence = [
      "Product owner decision recorded in AF-106"
    ];
  });
  assert.match(
    validateDeliveryMetadata(deferred, CONTEXT).errors.join("\n"),
    /Deferred without a matching approved exception/
  );

  const approved = withMetadata(deferred, (metadata) => {
    metadata.approvedExceptions = [
      {
        scope: "AF-106 AC-1 live Gemini verification",
        approver: "Jane Engineer",
        expiresAt: "2027-01-31",
        compensatingControl: "Keep Gemini disabled in production.",
        followUp: "Reverify live transport under the follow-up issue."
      }
    ];
  });
  assert.equal(
    validateDeliveryMetadata(approved, CONTEXT).errors.some((error) =>
      error.includes("Deferred without")
    ),
    false
  );
});

test("declared ticket keys agree across readable and structured evidence", () => {
  const result = validateDeliveryMetadata(
    validBody.replace(
      "- Ticket: AF-106",
      "- Ticket: AF-106\n- Related ticket: AF-104"
    ),
    CONTEXT
  );
  assert.match(result.errors.join("\n"), /names AF-104 but structured metadata does not/);
});

test("title, base, and test revisions are tied to the current pull request", () => {
  const stale = validateDeliveryMetadata(validBody, {
    ...CONTEXT,
    title: "delivery evidence",
    base: "main",
    headSha: "b".repeat(40)
  });
  const errors = stale.errors.join("\n");
  assert.match(errors, /title must include a declared Jira key/i);
  assert.match(errors, /targetBase does not match/);
  assert.match(errors, /revision is stale/);
});

test("Jira dependencies require source and native-link traceability", () => {
  const body = withMetadata(validBody, (metadata) => {
    metadata.dependencies = [
      {
        ticket: "AF-106",
        relationship: "is blocked by",
        reference: "AF-67",
        source: "Jira says so",
        nativeLink: "https://example.test/AF-67",
        status: "In Progress",
        blockingStage: "none",
        effect: "Production alert drills are incomplete.",
        owner: "Operations owner",
        nextAction: "Run the staging alert drill."
      }
    ];
  });
  const errors = validateDeliveryMetadata(body, CONTEXT).errors.join("\n");
  assert.match(errors, /source must be an HTTPS evidence URL/);
  assert.match(errors, /cannot be blocking while its blockingStage is none/);
  assert.match(errors, /nativeLink must link to the referenced Jira issue/);
});

test("dependencies must belong to a declared ticket", () => {
  const body = withMetadata(validBody, (metadata) => {
    metadata.dependencies = [
      {
        ticket: "AF-999",
        relationship: "related to",
        reference: "operating-runbook",
        source: "https://example.test/runbook",
        nativeLink: null,
        status: "Current",
        blockingStage: "none",
        effect: "Provides operator context.",
        owner: "Operations owner",
        nextAction: "Keep the runbook current."
      }
    ];
  });
  assert.match(
    validateDeliveryMetadata(body, CONTEXT).errors.join("\n"),
    /ticket must name a declared AF issue/
  );
});

test("related-only dependencies cannot silently block a delivery stage", () => {
  const body = withMetadata(validBody, (metadata) => {
    metadata.dependencies = [
      {
        ticket: "AF-106",
        relationship: "related to",
        reference: "operating-runbook",
        source: "https://example.test/runbook",
        nativeLink: null,
        status: "Current",
        blockingStage: "deployment",
        effect: "Provides operator context.",
        owner: "Operations owner",
        nextAction: "Keep the runbook current."
      }
    ];
  });
  assert.match(
    validateDeliveryMetadata(body, CONTEXT).errors.join("\n"),
    /related-only and must use blockingStage none/
  );
});

test("unknown fields are rejected without reflecting unsafe field names", () => {
  const body = withMetadata(validBody, (metadata) => {
    metadata["bad\n::error::injection"] = true;
  });
  const result = validateDeliveryMetadata(body, CONTEXT);
  const report = renderMarkdownReport(result);
  assert.match(report, /unsupported field '<unsafe-name>'/);
  assert.doesNotMatch(report, /::error::injection/);
});

test("malformed, duplicate, and oversized JSON blocks fail closed", () => {
  assert.throws(
    () => extractStructuredMetadata(validBody.replace('"schemaVersion"', "schemaVersion")),
    /valid JSON/
  );
  const block = /```json\n[\s\S]*?\n```/.exec(validBody)[0];
  assert.throws(
    () => extractStructuredMetadata(`${validBody}\n${block}\n`),
    /exactly one fenced JSON block/
  );
  assert.throws(
    () => extractStructuredMetadata(`${validBody}${"x".repeat(65_536)}`),
    /exceeds/
  );
});

test("a non-draft pull request needs complete ready evidence", () => {
  assert.match(
    validateDeliveryMetadata(validBody, { ...CONTEXT, isDraft: false }).errors.join("\n"),
    /readyEvidence is required/
  );

  const ready = withMetadata(validBody, (metadata) => {
    metadata.readyEvidence = {
      prNumber: 96,
      targetBase: "develop",
      headSha: HEAD,
      ciUrl: "https://github.com/FutureUnicorn/AI-Filter/actions/runs/123",
      status: "passed",
      jiraComments: [
        "https://hemnaathusa.atlassian.net/browse/AF-106?focusedCommentId=123"
      ]
    };
  });
  assert.equal(
    validateDeliveryMetadata(ready, { ...CONTEXT, isDraft: false }).errors.length,
    0
  );
});

test("ready evidence rejects invented PR numbers and stale heads", () => {
  const body = withMetadata(validBody, (metadata) => {
    metadata.readyEvidence = {
      prNumber: 999,
      targetBase: "main",
      headSha: "b".repeat(40),
      ciUrl: "https://example.test/not-actions",
      status: "pending",
      jiraComments: []
    };
  });
  const errors = validateDeliveryMetadata(body, {
    ...CONTEXT,
    isDraft: false
  }).errors.join("\n");
  assert.match(errors, /does not match the actual pull request/);
  assert.match(errors, /does not match the actual pull request base/);
  assert.match(errors, /stale for the current pull request/);
  assert.match(errors, /GitHub Actions URL/);
  assert.match(errors, /status must be passed/);
  assert.match(errors, /Jira comment URL per ticket/);
});

test("malformed field types become findings instead of exceptions", () => {
  const body = withMetadata(validBody, (metadata) => {
    metadata.tickets[0].acceptance[0].evidence = null;
    metadata.approvedExceptions = "not-an-array";
  });
  let result;
  assert.doesNotThrow(() => {
    result = validateDeliveryMetadata(body, CONTEXT);
  });
  const errors = result.errors.join("\n");
  assert.match(errors, /evidence must be an array/);
  assert.match(errors, /approvedExceptions must be an array/);
});

test("readable acceptance text must agree with structured metadata", () => {
  const body = validBody.replace(
    "Provider selection preserves the evidence contract | Met",
    "A different requirement | Unmet"
  );
  assert.match(
    validateDeliveryMetadata(body, CONTEXT).errors.join("\n"),
    /Readable acceptance criteria do not match/
  );
});

test("ready comments must point to the actual AF Jira site", () => {
  const body = withMetadata(validBody, (metadata) => {
    metadata.readyEvidence = {
      prNumber: 96,
      targetBase: "develop",
      headSha: HEAD,
      ciUrl: "https://github.com/FutureUnicorn/AI-Filter/actions/runs/123",
      status: "passed",
      jiraComments: ["https://example.test/browse/AF-106"]
    };
  });
  assert.match(
    validateDeliveryMetadata(body, { ...CONTEXT, isDraft: false }).errors.join("\n"),
    /Jira comment URL per ticket/
  );
});

test("GitHub event context reads data without executing PR text", () => {
  const context = contextFromGitHubEvent({
    pull_request: {
      number: 96,
      title: "AF-106: $(whoami)",
      body: validBody,
      draft: true,
      base: { ref: "develop" },
      head: { sha: HEAD }
    }
  });
  assert.equal(context.title, "AF-106: $(whoami)");
  assert.equal(context.body, validBody);
  assert.equal(context.headSha, HEAD);
});

test("report-only CLI annotates invalid input but exits successfully", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "af-delivery-"));
  const eventPath = path.join(temporary, "event.json");
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 96,
        title: "missing ticket",
        body: invalidBody,
        draft: true,
        base: { ref: "develop" },
        head: { sha: HEAD }
      }
    })
  );
  const output = execFileSync(
    process.execPath,
    [scriptPath, "--event", eventPath, "--report-only"],
    { encoding: "utf8" }
  );
  assert.match(output, /Result: needs attention/);
  assert.match(output, /::warning title=Delivery metadata::/);

  const strict = spawnSync(process.execPath, [scriptPath, "--event", eventPath], {
    encoding: "utf8"
  });
  assert.equal(strict.status, 1);
  fs.rmSync(temporary, { recursive: true, force: true });
});
