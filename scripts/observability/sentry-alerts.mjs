import { pathToFileURL } from "node:url";

const MONITORED_OPERATIONS = [
  "auth.magic_link.request",
  "auth.magic_link.redeem",
  "file.intake.create",
  "file.upload.complete",
  "file.validate",
  "file.extract_text",
  "csv.preview",
  "csv.finalize",
  "application.review_queue",
  "application.evidence",
  "application.evidence.correct",
  "application.decision"
];

function required(source, name) {
  const value = source[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to render AF-67 alert definitions`);
  }
  return value;
}

function positiveInteger(source, name, { allowZero = false } = {}) {
  const raw = required(source, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return value;
}

function optionalBoolean(source, name) {
  const raw = source[name]?.trim();
  if (raw === undefined || raw === "") {
    return false;
  }
  if (raw !== "true" && raw !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return raw === "true";
}

function parseP95Thresholds(source) {
  const raw = required(source, "SENTRY_ALERT_P95_THRESHOLDS_MS");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SENTRY_ALERT_P95_THRESHOLDS_MS must be a JSON object keyed by normalized operation");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("SENTRY_ALERT_P95_THRESHOLDS_MS must be a JSON object keyed by normalized operation");
  }
  const thresholds = {};
  for (const operation of MONITORED_OPERATIONS) {
    const value = parsed[operation];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`SENTRY_ALERT_P95_THRESHOLDS_MS must provide a positive integer for ${operation}`);
    }
    thresholds[operation] = value;
  }
  const unknown = Object.keys(parsed).filter((key) => !MONITORED_OPERATIONS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`SENTRY_ALERT_P95_THRESHOLDS_MS contains unknown operations: ${unknown.join(", ")}`);
  }
  return thresholds;
}

function conditions(threshold) {
  return {
    logicType: "any",
    conditions: [
      { type: "gt", comparison: threshold, conditionResult: 75 },
      { type: "lte", comparison: threshold, conditionResult: 0 }
    ],
    actions: []
  };
}

function spanDataSource({ aggregate, environment, query, timeWindow }) {
  return [{
    aggregate,
    dataset: "events_analytics_platform",
    environment,
    eventTypes: ["trace_item_span"],
    query,
    queryType: 1,
    timeWindow,
    extrapolationMode: "unknown"
  }];
}

export function buildDetectorDefinitions(source) {
  const environment = required(source, "APP_ENV");
  const webProject = required(source, "SENTRY_WEB_PROJECT");
  const workerProject = source.SENTRY_WORKER_PROJECT?.trim() || webProject;
  const timeWindow = positiveInteger(source, "SENTRY_ALERT_EVALUATION_WINDOW_SECONDS");
  const minimumEventVolume = positiveInteger(source, "SENTRY_ALERT_MIN_EVENT_VOLUME");
  const errorRateThreshold = positiveInteger(source, "SENTRY_ALERT_ERROR_RATE_THRESHOLD_PERCENT");
  if (errorRateThreshold > 100) {
    throw new Error("SENTRY_ALERT_ERROR_RATE_THRESHOLD_PERCENT must be at most 100");
  }
  const tokenBudgetEventThreshold = positiveInteger(
    source,
    "SENTRY_ALERT_TOKEN_BUDGET_EVENT_THRESHOLD"
  );
  const tokenBudgetProducerReady = optionalBoolean(
    source,
    "SENTRY_ALERT_TOKEN_BUDGET_PRODUCER_READY"
  );
  const workerErrorCountThreshold = positiveInteger(
    source,
    "SENTRY_ALERT_WORKER_ERROR_COUNT_THRESHOLD"
  );
  const p95Thresholds = parseP95Thresholds(source);
  const workflowIds = (source.SENTRY_ALERT_WORKFLOW_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("SENTRY_ALERT_WORKFLOW_IDS must contain comma-separated positive integer IDs");
      }
      return id;
    });
  const owner = source.SENTRY_ALERT_OWNER?.trim();
  if (owner !== undefined && !/^(team|user):[1-9][0-9]*$/u.test(owner)) {
    throw new Error("SENTRY_ALERT_OWNER must be a Sentry owner such as team:123 or user:456");
  }

  const common = {
    type: "metric_issue",
    workflow_ids: workflowIds,
    config: { detectionType: "static" },
    enabled: true,
    ...(owner === undefined ? {} : { owner })
  };
  const definitions = [{
    project: webProject,
    payload: {
      ...common,
      name: `[AF-67][${environment}] web unexpected error rate`,
      description:
        `Unexpected 5xx operation failure rate. Operations must validate at least ${minimumEventVolume} events ` +
        "in the evaluation window before enabling notifications; the current Sentry detector API has no second " +
        "AND-ed volume condition.",
      data_sources: spanDataSource({
        aggregate: "failure_rate()",
        environment,
        query: "service.name:web has:monitor.operation",
        timeWindow
      }),
      condition_group: conditions(errorRateThreshold)
    }
  }];

  definitions.push({
    project: workerProject,
    payload: {
      ...common,
      name: `[AF-67][${environment}] worker unexpected failures`,
      description:
        "Unexpected worker failures. This is a count until AF-102 supplies completed job volume for a real worker failure-rate denominator.",
      data_sources: [{
        aggregate: "count()",
        dataset: "events",
        environment,
        eventTypes: ["error"],
        query: "service:worker",
        queryType: 0,
        timeWindow
      }],
      condition_group: conditions(workerErrorCountThreshold)
    }
  });

  for (const operation of MONITORED_OPERATIONS) {
    definitions.push({
      project: webProject,
      payload: {
        ...common,
        name: `[AF-67][${environment}] P95 ${operation}`,
        description: `P95 duration for the normalized ${operation} server operation.`,
        data_sources: spanDataSource({
          aggregate: "p95(span.duration)",
          environment,
          query: `monitor.operation:${operation}`,
          timeWindow
        }),
        condition_group: conditions(p95Thresholds[operation])
      }
    });
  }

  definitions.push({
    project: workerProject,
    payload: {
      ...common,
      enabled: tokenBudgetProducerReady,
      name: `[AF-67][${environment}] inference token budget`,
      description:
        "Existing inference budget checks reported warning or capped. This is token-budget utilization, not monetary provider spend. " +
        "Keep disabled until AF-102 connects the durable production job consumer to executeBudgetedInference and a staging drill verifies delivery.",
      data_sources: spanDataSource({
        aggregate: "count()",
        environment,
        query: "monitor.operation:inference.token_budget monitor.budget.status:[warning,capped]",
        timeWindow
      }),
      condition_group: conditions(tokenBudgetEventThreshold)
    }
  });

  return definitions;
}

async function sentryRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...options.headers
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sentry API ${response.status} for ${url}: ${body.slice(0, 500)}`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function applyDefinitions(definitions, source) {
  const organization = encodeURIComponent(required(source, "SENTRY_ORG"));
  const token = required(source, "SENTRY_AUTH_TOKEN");
  if (definitions.some((definition) => definition.payload.workflow_ids.length === 0)) {
    throw new Error("SENTRY_ALERT_WORKFLOW_IDS is required with --apply so monitors have an external notification workflow");
  }
  if (definitions.some((definition) => definition.payload.owner === undefined)) {
    throw new Error("SENTRY_ALERT_OWNER is required with --apply so every monitor has an accountable owner");
  }
  const baseUrl = (source.SENTRY_API_BASE_URL?.trim() || "https://sentry.io/api/0").replace(/\/$/u, "");
  const existing = await sentryRequest(`${baseUrl}/organizations/${organization}/detectors/?per_page=100`, token);
  if (!Array.isArray(existing)) {
    throw new Error("Sentry monitor listing returned an unexpected response");
  }
  for (const definition of definitions) {
    const current = existing.find((detector) => detector?.name === definition.payload.name);
    const url = current === undefined
      ? `${baseUrl}/organizations/${organization}/projects/${encodeURIComponent(definition.project)}/detectors/`
      : `${baseUrl}/organizations/${organization}/detectors/${encodeURIComponent(String(current.id))}/`;
    await sentryRequest(url, token, {
      method: current === undefined ? "POST" : "PUT",
      body: JSON.stringify(definition.payload)
    });
    process.stdout.write(`${current === undefined ? "created" : "updated"} ${definition.payload.name}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const definitions = buildDetectorDefinitions(process.env);
  if (process.argv.includes("--apply")) {
    await applyDefinitions(definitions, process.env);
  } else {
    process.stdout.write(`${JSON.stringify(definitions, null, 2)}\n`);
  }
}

export { MONITORED_OPERATIONS };
