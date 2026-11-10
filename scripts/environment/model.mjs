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

/**
 * AF-94: compose interpolated POSTGRES_USER/POSTGRES_PASSWORD directly into
 * this URI. A secret-manager-generated password containing a URI delimiter
 * (`/`, `?`, `#`, `@`) either makes the string invalid or silently changes
 * how its authority parses (`p@ss` moves everything before the last `@`
 * into userinfo). Percent-encoding at construction closes that without
 * constraining what a secret manager is allowed to generate.
 */
export function buildDatabaseUrl({ user, password, database, host = "postgres", port = 5432 }) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
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

/**
 * AF-94: the official Postgres image applies POSTGRES_USER/POSTGRES_PASSWORD
 * only when the data directory is empty -- they are initialisation
 * variables, not runtime ones. Staging and production use a persistent
 * volume, so rotating POSTGRES_PASSWORD alone changes what migrate/web/worker
 * send without changing what the database role accepts. Rotation therefore
 * requires the outgoing password too, so an explicit ALTER ROLE step can
 * authenticate with it before the new one takes over.
 */
export function requireRotationControls(source) {
  const previousPassword = source.POSTGRES_PASSWORD_PREVIOUS ?? "";
  const nextPassword = source.POSTGRES_PASSWORD ?? "";
  if (previousPassword.trim() === "") {
    throw new Error("POSTGRES_PASSWORD_PREVIOUS is required to rotate the database password");
  }
  if (nextPassword.length < 20) {
    throw new Error("Hosted infrastructure secrets must be at least 20 characters");
  }
  if (nextPassword === previousPassword) {
    throw new Error("POSTGRES_PASSWORD must differ from POSTGRES_PASSWORD_PREVIOUS to rotate");
  }
  return { previousPassword, nextPassword };
}

/**
 * The docker argv that runs psql against a hosted environment's database.
 *
 * Reaching the database from a throwaway container on the environment's
 * private network -- rather than `docker exec` into the postgres container
 * itself -- is what makes the password real. Review (#86, REV-001) showed
 * the earlier `-h 127.0.0.1` did not: `initdb` generates
 * `host all all 127.0.0.1/32 trust` and the image's entrypoint *appends*
 * `host all all all scram-sha-256`, so a loopback connection matches the
 * trust rule first and the password is accepted and discarded. Verified by
 * reproduction: over loopback a deliberately wrong password connects; from
 * a non-loopback address the same wrong password is rejected.
 *
 * Takes no password: PGPASSWORD is forwarded by name, so no secret can
 * reach any process's argv.
 */
export function buildRotationCommand({ image, network, user, database, host = "postgres" }) {
  return [
    "run",
    "--rm",
    "--interactive",
    "--network",
    network,
    "--env",
    "PGPASSWORD",
    "--env",
    "SIGNAL_AUDIT_NEXT_PASSWORD",
    image,
    "psql",
    "--no-psqlrc",
    "-v",
    "ON_ERROR_STOP=1",
    "--host",
    host,
    "--username",
    user,
    "--dbname",
    database
  ];
}

/**
 * psql reads the incoming password from its environment with `\\getenv` and
 * performs SQL-literal quoting via `:'nextpw'`. The secret therefore never
 * appears in the SQL text or in diagnostics that echo the statement.
 */
export function buildAlterRolePasswordStatement(user) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(user ?? "")) {
    throw new Error("POSTGRES_USER must be a safe PostgreSQL identifier to rotate its password");
  }
  return `\\getenv nextpw SIGNAL_AUDIT_NEXT_PASSWORD\nALTER ROLE "${user}" WITH PASSWORD :'nextpw';\n`;
}

/** Categorize captured Docker/psql output without ever returning raw output. */
export function classifyRotationFailure(result) {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const errorCode = result.error?.code;

  if (
    errorCode === "ENOENT" ||
    errorCode === "EACCES" ||
    /docker(?:\.exe)?: (?:command not found|not recognized)/iu.test(output) ||
    /cannot connect to the docker daemon|failed to connect to (?:the )?docker|error during connect|docker daemon is not running/iu.test(output)
  ) {
    return "docker-unavailable";
  }
  if (/manifest unknown|pull access denied|failed to resolve reference|unable to pull image|no such image|failed to pull|pulling .* failed/iu.test(output)) {
    return "image-unavailable";
  }
  if (errorCode === "ETIMEDOUT" || /\bETIMEDOUT\b|timed? ?out|timeout expired|deadline exceeded|i\/o timeout/iu.test(output)) return "timeout";
  if (errorCode === "ECONNREFUSED" || /\bECONNREFUSED\b|connection refused/iu.test(output)) return "connection-refused";
  if (/could not translate host name|name or service not known|network is unreachable|no route to host|temporary failure in name resolution/iu.test(output)) {
    return "network-unavailable";
  }
  if (/SQLSTATE[^\r\n]*28P01|\b28P01\b|password authentication failed/iu.test(output)) {
    return "authentication";
  }
  if (/SQLSTATE[^\r\n]*57P03|\b57P03\b|database system is (?:starting up|not yet accepting connections)|server is starting/iu.test(output)) {
    return "container-not-ready";
  }
  return "command-failed";
}

/** Safe operator guidance; never includes Docker/psql output that may echo SQL. */
export function rotationFailureMessage(appEnv, failure, status) {
  const suffix = status === null || status === undefined ? "" : ` (exit status ${status})`;
  const messages = {
    authentication: `the outgoing database password was rejected for ${appEnv}; verify POSTGRES_PASSWORD_PREVIOUS is the password the role currently accepts`,
    "docker-unavailable": "Docker is unavailable or its daemon cannot be reached; install/start Docker and verify daemon access",
    "image-unavailable": "the psql image could not be pulled; verify registry access and the image reference, then retry",
    "container-not-ready": "the PostgreSQL container is not ready; wait for its health check to pass, then retry",
    "connection-refused": "the PostgreSQL endpoint refused the connection; verify the container and private network are healthy, then retry",
    "network-unavailable": "the Docker private network cannot reach PostgreSQL; verify the project network and postgres service, then retry",
    timeout: "the PostgreSQL connection timed out; inspect Docker/network/database health before retrying",
    "command-failed": "the Docker/psql command failed for an unclassified reason; inspect Docker and PostgreSQL health before retrying"
  };
  return `password rotation for ${appEnv} failed${suffix}: ${messages[failure] ?? messages["command-failed"]}.`;
}

export function derivePreviewEnvironment(prValue, shaValue, source = process.env) {
  const pr = validatePullRequestNumber(prValue);
  const sha = validateCommitSha(shaValue);
  const shortSha = sha.slice(0, 12);
  const port = 10_000 + (pr % 40_000);
  const suffix = crypto.randomBytes(18).toString("base64url");
  const baseDomain = source.PREVIEW_BASE_DOMAIN?.trim();
  const postgresUser = `preview_${pr}`;
  const postgresPassword = `preview-db-${suffix}`;
  const postgresDb = "signal_audit_preview";

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
      POSTGRES_DB: postgresDb,
      POSTGRES_USER: postgresUser,
      POSTGRES_PASSWORD: postgresPassword,
      DATABASE_URL: buildDatabaseUrl({ user: postgresUser, password: postgresPassword, database: postgresDb }),
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
