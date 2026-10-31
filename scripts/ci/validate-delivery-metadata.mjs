#!/usr/bin/env node
// AF-DELIVERY-1.0: structural PR metadata validation only.
// This file uses no Jira credentials and does not independently verify external evidence.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 65_536;
const REQUIRED_SECTIONS = [
  "Jira and outcome",
  "Acceptance criteria",
  "Dependencies",
  "Verification",
  "Security, product boundary, and operations",
  "AI assistance and accountability",
  "Jira ready-for-review handoff",
  "Structured delivery metadata"
];
const TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "targetBase",
  "tickets",
  "dependencies",
  "tests",
  "humanEvidenceOwner",
  "aiAssistance",
  "rollout",
  "approvedExceptions",
  "readyEvidence"
];
const ACCEPTANCE_STATES = new Set(["Met", "Unmet", "Deferred", "Not verified"]);
const DEPENDENCY_RELATIONSHIPS = new Set([
  "blocks",
  "is blocked by",
  "depends on",
  "related to"
]);
const BLOCKING_STAGES = new Set(["review", "merge", "deployment", "Done", "none"]);
const TEST_CLASSIFICATIONS = new Set([
  "automated",
  "mocked",
  "live",
  "manual",
  "unverified"
]);
const FULL_SHA = /^[0-9a-f]{40}$/i;
const ISSUE_KEY = /^AF-\d+$/;
const PLACEHOLDER = /AF-\[number\]|\[(?:criterion|action and human owner|path or URL|full SHA|CI URL or reason|base|number after draft creation|links|github or team identity|providers\/tools or None)\]|Replace with/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value, minimum = 1) {
  return (
    typeof value === "string" &&
    value.trim().length >= minimum &&
    !PLACEHOLDER.test(value)
  );
}

function isHttpsUrl(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isProjectJiraUrl(value, key) {
  if (!isHttpsUrl(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.origin === "https://hemnaathusa.atlassian.net" &&
    url.pathname === `/browse/${key}`
  );
}

function isHumanIdentity(value) {
  return (
    isText(value, 2) &&
    !/\b(?:AI|bot|assistant|Codex|Copilot|Claude|Gemini)\b/i.test(value)
  );
}

function sectionsOf(markdown) {
  const sections = new Map();
  let current = null;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1].trim();
      sections.set(current, "");
    } else if (current) {
      sections.set(current, `${sections.get(current)}${line}\n`);
    }
  }
  return sections;
}

function meaningfulSection(value) {
  const withoutComments = (value ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  return withoutComments.length > 8 && !PLACEHOLDER.test(withoutComments);
}

function safeFieldName(value) {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : "<unsafe-name>";
}

function requireExactFields(errors, value, fields, path) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return false;
  }
  const actual = Object.keys(value);
  const missing = fields.filter((field) => !actual.includes(field));
  const extra = actual.filter((field) => !fields.includes(field));
  for (const field of missing) {
    errors.push(`${path} is missing '${field}'.`);
  }
  for (const field of extra) {
    errors.push(`${path} contains unsupported field '${safeFieldName(field)}'.`);
  }
  return missing.length === 0 && extra.length === 0;
}

export function extractStructuredMetadata(markdown) {
  if (typeof markdown !== "string") {
    throw new Error("Pull request body must be text.");
  }
  if (Buffer.byteLength(markdown, "utf8") > MAX_BODY_BYTES) {
    throw new Error("Pull request body exceeds the 65536-byte validation limit.");
  }
  const section = sectionsOf(markdown).get("Structured delivery metadata");
  if (section === undefined) {
    throw new Error("Missing '## Structured delivery metadata'.");
  }
  const blocks = [...section.matchAll(/^[ \t]*```json[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gim)];
  if (blocks.length !== 1) {
    throw new Error("Structured delivery metadata must contain exactly one fenced JSON block.");
  }
  let metadata;
  try {
    metadata = JSON.parse(blocks[0][1]);
  } catch {
    throw new Error("Structured delivery metadata must be valid JSON.");
  }
  if (!isRecord(metadata)) {
    throw new Error("Structured delivery metadata must be a JSON object.");
  }
  return metadata;
}

function validateAcceptance(errors, tickets, exceptions) {
  const seenTickets = new Set();
  for (const [ticketIndex, ticket] of tickets.entries()) {
    const path = `tickets[${ticketIndex}]`;
    if (!requireExactFields(errors, ticket, ["key", "acceptance"], path)) {
      continue;
    }
    if (!ISSUE_KEY.test(ticket.key ?? "")) {
      errors.push(`${path}.key must match AF-123.`);
      continue;
    }
    if (seenTickets.has(ticket.key)) {
      errors.push(`${path}.key duplicates another ticket.`);
    }
    seenTickets.add(ticket.key);
    if (!Array.isArray(ticket.acceptance) || ticket.acceptance.length === 0) {
      errors.push(`${path}.acceptance must contain at least one criterion.`);
      continue;
    }
    const seenCriteria = new Set();
    for (const [criterionIndex, criterion] of ticket.acceptance.entries()) {
      const criterionPath = `${path}.acceptance[${criterionIndex}]`;
      if (
        !requireExactFields(
          errors,
          criterion,
          ["id", "description", "status", "evidence", "remainingAction"],
          criterionPath
        )
      ) {
        continue;
      }
      if (!isText(criterion.id, 2) || !isText(criterion.description, 8)) {
        errors.push(`${criterionPath} needs a criterion id and description.`);
      }
      if (seenCriteria.has(criterion.id)) {
        errors.push(`${criterionPath}.id duplicates another criterion for ${ticket.key}.`);
      }
      seenCriteria.add(criterion.id);
      if (!ACCEPTANCE_STATES.has(criterion.status)) {
        errors.push(`${criterionPath}.status must be Met, Unmet, Deferred, or Not verified.`);
      }
      if (
        !Array.isArray(criterion.evidence) ||
        !criterion.evidence.every((entry) => isText(entry, 3))
      ) {
        errors.push(`${criterionPath}.evidence must be an array of paths, URLs, or qualified reasons.`);
      }
      if (
        criterion.status === "Met" &&
        (!Array.isArray(criterion.evidence) || criterion.evidence.length === 0)
      ) {
        errors.push(`${criterionPath} cannot be Met without evidence.`);
      }
      if (!isText(criterion.remainingAction, 3)) {
        errors.push(`${criterionPath}.remainingAction must name the action and human owner, or explain why none remains.`);
      }
      if (criterion.status === "Deferred") {
        const hasApproval = exceptions.some(
          (exception) =>
            isRecord(exception) &&
            typeof exception.scope === "string" &&
            exception.scope.includes(ticket.key) &&
            exception.scope.includes(criterion.id)
        );
        if (!hasApproval) {
          errors.push(`${criterionPath} is Deferred without a matching approved exception scope.`);
        }
      }
    }
  }
  return seenTickets;
}

function validateDependencies(errors, dependencies) {
  if (!Array.isArray(dependencies)) {
    errors.push("dependencies must be an array.");
    return;
  }
  for (const [index, dependency] of dependencies.entries()) {
    const path = `dependencies[${index}]`;
    if (
      !requireExactFields(
        errors,
        dependency,
        [
          "relationship",
          "reference",
          "source",
          "nativeLink",
          "status",
          "blockingStage",
          "effect",
          "owner",
          "nextAction"
        ],
        path
      )
    ) {
      continue;
    }
    if (!DEPENDENCY_RELATIONSHIPS.has(dependency.relationship)) {
      errors.push(`${path}.relationship is invalid.`);
    }
    for (const field of ["reference", "status", "effect", "owner", "nextAction"]) {
      if (!isText(dependency[field], 2)) {
        errors.push(`${path}.${field} must be meaningful text.`);
      }
    }
    if (!isHttpsUrl(dependency.source)) {
      errors.push(`${path}.source must be an HTTPS evidence URL.`);
    }
    if (!BLOCKING_STAGES.has(dependency.blockingStage)) {
      errors.push(`${path}.blockingStage must be review, merge, deployment, Done, or none.`);
    }
    if (
      dependency.relationship === "is blocked by" &&
      dependency.blockingStage === "none"
    ) {
      errors.push(`${path} cannot be blocking while its blockingStage is none.`);
    }
    if (
      dependency.relationship === "related to" &&
      dependency.blockingStage !== "none"
    ) {
      errors.push(`${path} is related-only and must use blockingStage none.`);
    }
    const jiraReference = ISSUE_KEY.test(dependency.reference ?? "");
    if (jiraReference) {
      if (
        !isProjectJiraUrl(dependency.nativeLink, dependency.reference)
      ) {
        errors.push(`${path}.nativeLink must link to the referenced Jira issue.`);
      }
    } else if (dependency.nativeLink !== null && !isHttpsUrl(dependency.nativeLink)) {
      errors.push(`${path}.nativeLink must be null or an HTTPS URL.`);
    }
  }
}

function validateTests(errors, tests, context) {
  if (!Array.isArray(tests) || tests.length === 0) {
    errors.push("tests must contain at least one verification record.");
    return;
  }
  for (const [index, testRecord] of tests.entries()) {
    const path = `tests[${index}]`;
    if (
      !requireExactFields(
        errors,
        testRecord,
        ["classification", "command", "revision", "result", "evidence"],
        path
      )
    ) {
      continue;
    }
    if (!TEST_CLASSIFICATIONS.has(testRecord.classification)) {
      errors.push(`${path}.classification is invalid.`);
    }
    if (!isText(testRecord.command, 3) || !isText(testRecord.result, 3)) {
      errors.push(`${path} needs an exact command/procedure and result.`);
    }
    if (!FULL_SHA.test(testRecord.revision ?? "")) {
      errors.push(`${path}.revision must be a full 40-character SHA.`);
    } else if (context.headSha && testRecord.revision !== context.headSha) {
      errors.push(`${path}.revision is stale for the current PR head.`);
    }
    if (!isText(testRecord.evidence, 3)) {
      errors.push(`${path}.evidence must name a URL, path, or qualified local result.`);
    }
    if (
      testRecord.classification === "unverified" &&
      !/\b(?:not[- ]run|unverified|blocked)\b/i.test(testRecord.result)
    ) {
      errors.push(`${path} classified as unverified must say not-run, unverified, or blocked.`);
    }
  }
}

function validateExceptions(errors, exceptions) {
  if (!Array.isArray(exceptions)) {
    errors.push("approvedExceptions must be an array.");
    return;
  }
  for (const [index, exception] of exceptions.entries()) {
    const path = `approvedExceptions[${index}]`;
    if (
      !requireExactFields(
        errors,
        exception,
        ["scope", "approver", "expiresAt", "compensatingControl", "followUp"],
        path
      )
    ) {
      continue;
    }
    if (!isText(exception.scope, 5)) {
      errors.push(`${path}.scope must identify the exact exception.`);
    }
    if (!isHumanIdentity(exception.approver)) {
      errors.push(`${path}.approver must name a human approver.`);
    }
    if (
      typeof exception.expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(exception.expiresAt) ||
      Number.isNaN(Date.parse(`${exception.expiresAt}T00:00:00Z`))
    ) {
      errors.push(`${path}.expiresAt must be a valid YYYY-MM-DD date.`);
    }
    if (
      !isText(exception.compensatingControl, 8) ||
      !isText(exception.followUp, 8)
    ) {
      errors.push(`${path} needs a compensating control and follow-up.`);
    }
  }
}

function validateReadyEvidence(errors, readyEvidence, context, issueKeys) {
  if (readyEvidence === null) {
    if (context.isDraft === false) {
      errors.push("readyEvidence is required when the pull request is not a draft.");
    }
    return;
  }
  if (
    !requireExactFields(
      errors,
      readyEvidence,
      ["prNumber", "targetBase", "headSha", "ciUrl", "status", "jiraComments"],
      "readyEvidence"
    )
  ) {
    return;
  }
  if (!Number.isInteger(readyEvidence.prNumber) || readyEvidence.prNumber < 1) {
    errors.push("readyEvidence.prNumber must be a positive integer.");
  } else if (context.prNumber && readyEvidence.prNumber !== context.prNumber) {
    errors.push("readyEvidence.prNumber does not match the actual pull request.");
  }
  if (!isText(readyEvidence.targetBase, 2)) {
    errors.push("readyEvidence.targetBase is required.");
  } else if (context.base && readyEvidence.targetBase !== context.base) {
    errors.push("readyEvidence.targetBase does not match the actual pull request base.");
  }
  if (!FULL_SHA.test(readyEvidence.headSha ?? "")) {
    errors.push("readyEvidence.headSha must be a full 40-character SHA.");
  } else if (context.headSha && readyEvidence.headSha !== context.headSha) {
    errors.push("readyEvidence.headSha is stale for the current pull request.");
  }
  if (
    !isHttpsUrl(readyEvidence.ciUrl) ||
    !readyEvidence.ciUrl.startsWith("https://github.com/FutureUnicorn/AI-Filter/actions/")
  ) {
    errors.push("readyEvidence.ciUrl must be an AI-Filter GitHub Actions URL.");
  }
  if (readyEvidence.status !== "passed") {
    errors.push("readyEvidence.status must be passed.");
  }
  if (
    !Array.isArray(readyEvidence.jiraComments) ||
    issueKeys.size === 0 ||
    readyEvidence.jiraComments.length !== issueKeys.size ||
    ![...issueKeys].every((key) =>
      readyEvidence.jiraComments.some((url) => isProjectJiraUrl(url, key))
    )
  ) {
    errors.push("readyEvidence.jiraComments must contain an HTTPS Jira comment URL per ticket.");
  }
}

export function validateDeliveryMetadata(markdown, context = {}) {
  const errors = [];
  const sections = sectionsOf(typeof markdown === "string" ? markdown : "");
  for (const section of REQUIRED_SECTIONS) {
    if (!meaningfulSection(sections.get(section))) {
      errors.push(`Missing, empty, or unfilled '## ${section}'.`);
    }
  }

  let metadata;
  try {
    metadata = extractStructuredMetadata(markdown);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Structured metadata is invalid.");
    return { ok: false, issueKeys: [], errors, metadata: null };
  }

  requireExactFields(errors, metadata, TOP_LEVEL_FIELDS, "metadata");
  if (metadata.schemaVersion !== "1.0") {
    errors.push("schemaVersion must be 1.0.");
  }
  if (!isText(metadata.targetBase, 2)) {
    errors.push("targetBase is required.");
  } else if (context.base && metadata.targetBase !== context.base) {
    errors.push("targetBase does not match the actual pull request base.");
  }

  validateExceptions(errors, metadata.approvedExceptions);
  const approvedExceptions = Array.isArray(metadata.approvedExceptions)
    ? metadata.approvedExceptions
    : [];

  const tickets = Array.isArray(metadata.tickets) ? metadata.tickets : [];
  if (tickets.length === 0) {
    errors.push("tickets must contain at least one AF issue.");
  }
  const structuredKeys = validateAcceptance(
    errors,
    tickets,
    approvedExceptions
  );

  const readableKeys = new Set(
    (sections.get("Jira and outcome")?.match(/\bAF-\d+\b/g) ?? [])
  );
  for (const key of structuredKeys) {
    if (!readableKeys.has(key)) {
      errors.push(`Jira and outcome does not mention structured ticket ${key}.`);
    }
    if (!(sections.get("Acceptance criteria") ?? "").includes(key)) {
      errors.push(`Acceptance criteria does not include a readable row for ${key}.`);
    }
  }
  for (const key of readableKeys) {
    if (!structuredKeys.has(key)) {
      errors.push(`Jira and outcome names ${key} but structured metadata does not.`);
    }
  }
  const readableAcceptance = sections.get("Acceptance criteria") ?? "";
  for (const ticket of tickets) {
    if (!isRecord(ticket) || !Array.isArray(ticket.acceptance)) {
      continue;
    }
    for (const criterion of ticket.acceptance) {
      if (
        isRecord(criterion) &&
        (!readableAcceptance.includes(criterion.description) ||
          !readableAcceptance.includes(criterion.status))
      ) {
        errors.push("Readable acceptance criteria do not match a structured criterion.");
      }
    }
  }
  if (
    context.title &&
    ![...structuredKeys].some((key) => context.title.toUpperCase().includes(key))
  ) {
    errors.push("Pull request title must include a declared Jira key.");
  }

  validateDependencies(errors, metadata.dependencies);
  const readableDependencies = sections.get("Dependencies") ?? "";
  if (Array.isArray(metadata.dependencies)) {
    for (const dependency of metadata.dependencies) {
      if (
        isRecord(dependency) &&
        (!readableDependencies.includes(dependency.relationship) ||
          !readableDependencies.includes(dependency.reference) ||
          !readableDependencies.includes(dependency.blockingStage))
      ) {
        errors.push("Readable dependencies do not match a structured dependency record.");
      }
    }
  }
  validateTests(errors, metadata.tests, context);
  const readableVerification = sections.get("Verification") ?? "";
  if (Array.isArray(metadata.tests)) {
    for (const testRecord of metadata.tests) {
      if (
        isRecord(testRecord) &&
        (!readableVerification.includes(testRecord.classification) ||
          !readableVerification.includes(testRecord.command))
      ) {
        errors.push("Readable verification does not match a structured test record.");
      }
    }
  }

  if (!isHumanIdentity(metadata.humanEvidenceOwner)) {
    errors.push("humanEvidenceOwner must name a human, not an assistant or placeholder.");
  }
  if (
    !Array.isArray(metadata.aiAssistance) ||
    !metadata.aiAssistance.every((entry) => isText(entry, 2))
  ) {
    errors.push("aiAssistance must be an array of provider/tool names, or an empty array.");
  }

  if (
    !requireExactFields(errors, metadata.rollout, ["plan", "rollback"], "rollout") ||
    !isText(metadata.rollout?.plan, 8) ||
    !isText(metadata.rollout?.rollback, 8)
  ) {
    errors.push("rollout must provide meaningful plan and rollback text.");
  }

  validateReadyEvidence(errors, metadata.readyEvidence, context, structuredKeys);

  const security = sections.get("Security, product boundary, and operations") ?? "";
  for (const label of ["Product policy:", "Rollout:", "Rollback:"]) {
    if (!security.includes(label)) {
      errors.push(`Security section must include '${label}'.`);
    }
  }
  if (!/Tenant isolation|no tenant|tenant-neutral/i.test(security)) {
    errors.push("Security section must state the tenant-isolation impact.");
  }

  const dependenciesSection = sections.get("Dependencies") ?? "";
  if (
    Array.isArray(metadata.dependencies) &&
    metadata.dependencies.length === 0 &&
    !/^None\s*[-:]\s*\S.{8,}/im.test(dependenciesSection)
  ) {
    errors.push("Readable dependencies must explain why none exist.");
  }

  return {
    ok: errors.length === 0,
    issueKeys: [...structuredKeys],
    errors,
    metadata
  };
}

function escapeWorkflowCommand(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

export function renderMarkdownReport(result) {
  const lines = [
    "# Delivery Policy / PR Metadata",
    "",
    result.ok ? "**Result: structurally complete**" : "**Result: needs attention**",
    ""
  ];
  if (result.ok) {
    lines.push("- The readable sections and JSON metadata are structurally valid.");
  } else {
    for (const error of result.errors) {
      lines.push(`- ${error}`);
    }
  }
  lines.push(
    "",
    "> Report only: this check does not verify Jira, CI, links, approvals, deployments, or acceptance evidence.",
    ""
  );
  return lines.join("\n");
}

export function contextFromGitHubEvent(event) {
  const pullRequest = event?.pull_request;
  if (!isRecord(pullRequest)) {
    throw new Error("GitHub event does not contain a pull_request object.");
  }
  return {
    body: typeof pullRequest.body === "string" ? pullRequest.body : "",
    title: typeof pullRequest.title === "string" ? pullRequest.title : "",
    base: pullRequest.base?.ref,
    headSha: pullRequest.head?.sha,
    prNumber: pullRequest.number,
    isDraft: pullRequest.draft === true
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function runCli() {
  const args = process.argv.slice(2);
  const reportOnly = args.includes("--report-only");
  const filePath = valueAfter(args, "--file");
  const eventPath = valueAfter(args, "--event") ?? process.env.GITHUB_EVENT_PATH;
  if ((filePath && eventPath) || (!filePath && !eventPath)) {
    process.stderr.write(
      "Usage: node scripts/ci/validate-delivery-metadata.mjs (--file <pr.md> | --event <event.json>) [--report-only]\n"
    );
    process.exitCode = 2;
    return;
  }

  let body;
  let context = {};
  try {
    if (eventPath) {
      const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
      const eventContext = contextFromGitHubEvent(event);
      body = eventContext.body;
      context = eventContext;
    } else {
      body = fs.readFileSync(filePath, "utf8");
    }
  } catch {
    process.stderr.write("Delivery metadata input could not be read or parsed.\n");
    process.exitCode = reportOnly ? 0 : 2;
    return;
  }

  const result = validateDeliveryMetadata(body, context);
  const report = renderMarkdownReport(result);
  process.stdout.write(`${report}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report, "utf8");
  }
  if (!result.ok && reportOnly) {
    for (const error of result.errors) {
      process.stdout.write(
        `::warning title=Delivery metadata::${escapeWorkflowCommand(error)}\n`
      );
    }
  }
  if (!result.ok && !reportOnly) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
