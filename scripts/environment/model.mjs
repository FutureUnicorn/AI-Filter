import crypto from "node:crypto";
import path from "node:path";

const hostedEnvironments = new Set(["staging", "production"]);

/**
 * AF-93 PR #85 review (hemnaath04, REV-002, blocking). Where preview
 * credential state lives is the single most consequential fact in the
 * high-severity fix this ticket shipped: get it wrong and every other
 * preview's database/storage secrets are readable from the untrusted PR
 * checkout that builds and runs cli.mjs. The original guard test only
 * asserted that the string `process.env.PREVIEW_STATE_DIRECTORY` appeared
 * somewhere in cli.mjs -- satisfied by a reference nothing reads from.
 *
 * Extracted as its own exported, source-independent function so a test can
 * call it directly with a synthetic `source` and assert the RESOLVED path,
 * the same way derivePreviewEnvironment below is tested -- no docker, no
 * subprocess, and no way for an unused reference to the env var to pass.
 */
export function resolvePreviewStateDirectory(repositoryRoot, source = process.env) {
  const configured = source.PREVIEW_STATE_DIRECTORY;
  if (configured !== undefined && configured.trim() !== "") {
    return path.resolve(configured);
  }
  return path.join(repositoryRoot, ".runtime");
}

export function validateCommitSha(value) {
  if (!/^[a-f0-9]{7,64}$/u.test(value ?? "")) {
    throw new Error("A 7-64 character lowercase hexadecimal commit SHA is required");
  }
  return value;
}

export function validatePullRequestNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("A positive pull-request number is required");
  }
  return number;
}

export function assertDestructiveEnvironmentAllowed(appEnv, operation) {
  if (appEnv === "staging" || appEnv === "production") {
    throw new Error(`${operation} is forbidden in ${appEnv}`);
  }
}

export function requireHostedControls(appEnv, source) {
  if (!hostedEnvironments.has(appEnv)) {
    return;
  }
  const required = [
    "AF11_ENABLE_HOSTED_ENVIRONMENTS",
    "COST_CONTROL_REFERENCE",
    "COST_CONTROL_OWNER",
    "ADMIN_AUDIT_REFERENCE",
    "ADMIN_ROLE_ALLOWLIST",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY"
  ];
  for (const key of required) {
    if ((source[key] ?? "").trim() === "") {
      throw new Error(`${key} is required to deploy ${appEnv}`);
    }
  }
  if (source.AF11_ENABLE_HOSTED_ENVIRONMENTS !== "true") {
    throw new Error("Hosted AF-11 environments are disabled by default");
  }
  if (appEnv === "production" && source.PRODUCTION_VALIDATION_ONLY !== "true") {
    throw new Error("Production is restricted to empty synthetic infrastructure validation");
  }
  if (source.POSTGRES_PASSWORD.length < 20 || source.STORAGE_SECRET_ACCESS_KEY.length < 20) {
    throw new Error("Hosted infrastructure secrets must be at least 20 characters");
  }
}

export function derivePreviewEnvironment(prValue, shaValue, source = process.env) {
  const pr = validatePullRequestNumber(prValue);
  const sha = validateCommitSha(shaValue);
  const shortSha = sha.slice(0, 12);
  const port = 10_000 + (pr % 40_000);
  const suffix = crypto.randomBytes(18).toString("base64url");
  const baseDomain = source.PREVIEW_BASE_DOMAIN?.trim();

  return {
    createdAt: new Date().toISOString(),
    pr,
    sha,
    project: `signal-audit-pr-${pr}-${shortSha}`,
    url:
      baseDomain === undefined || baseDomain === ""
        ? `http://127.0.0.1:${port}`
        : `https://pr-${pr}.${baseDomain}`,
    variables: {
      APP_ENV: "preview",
      DEPLOYMENT_COMMIT_SHA: sha,
      PREVIEW_ID: `pr-${pr}`,
      PREVIEW_COMMIT_SHA: sha,
      POSTGRES_DB: "signal_audit_preview",
      POSTGRES_USER: `preview_${pr}`,
      POSTGRES_PASSWORD: `preview-db-${suffix}`,
      DATABASE_SCHEMA: `pr_${pr}_${shortSha}`,
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: `signal-audit-preview-pr-${pr}-${shortSha}`,
      STORAGE_ACCESS_KEY_ID: `preview-${pr}-${shortSha}`,
      STORAGE_SECRET_ACCESS_KEY: `preview-storage-${suffix}`,
      WEB_HOST_PORT: String(port),
      WEB_BIND_ADDRESS: source.PREVIEW_BIND_ADDRESS ?? "127.0.0.1"
    }
  };
}

export function environmentIdentity(name, variables) {
  return {
    name,
    databaseBoundary: `${variables.POSTGRES_DB}/${variables.DATABASE_SCHEMA}`,
    storageBoundary: variables.STORAGE_BUCKET,
    credentialIdentity: `${variables.POSTGRES_USER}/${variables.STORAGE_ACCESS_KEY_ID}`
  };
}
