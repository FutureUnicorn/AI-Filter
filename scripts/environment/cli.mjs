import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDestructiveEnvironmentAllowed,
  buildAlterRolePasswordStatement,
  buildDatabaseUrl,
  derivePreviewEnvironment,
  requireHostedControls,
  requireRotationControls,
  validateCommitSha,
  validatePullRequestNumber
} from "./model.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeDirectory = path.join(repositoryRoot, ".runtime");
const previewDirectory = path.join(runtimeDirectory, "previews");
const composeFile = path.join(repositoryRoot, "infra/compose/runtime.yml");
const localComposeFile = path.join(repositoryRoot, "infra/compose/local.yml");

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function runDocker(project, variables, arguments_, local = false) {
  const files = ["compose", "-f", composeFile];
  if (local) files.push("-f", localComposeFile);
  files.push("--project-name", project, ...arguments_);
  const result = spawnSync("docker", files, {
    cwd: repositoryRoot,
    env: { ...process.env, ...variables },
    stdio: "inherit"
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ${files.join(" ")} failed with status ${result.status}`);
  }
}

function localEnvironment() {
  const requestedEnvironment = process.env.APP_ENV ?? "development";
  if (requestedEnvironment !== "development" && requestedEnvironment !== "test") {
    assertDestructiveEnvironmentAllowed(requestedEnvironment, "local infrastructure command");
    throw new Error(`Local infrastructure cannot target ${requestedEnvironment}`);
  }
  return {
    project: "signal-audit-development",
    variables: {
      APP_ENV: "development",
      DEPLOYMENT_COMMIT_SHA: "local",
      POSTGRES_DB: "signal_audit_local",
      POSTGRES_USER: "signal_audit_local",
      POSTGRES_PASSWORD: "local-only-password",
      DATABASE_URL: buildDatabaseUrl({
        user: "signal_audit_local",
        password: "local-only-password",
        database: "signal_audit_local"
      }),
      DATABASE_SCHEMA: "public",
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: "signal-audit-development",
      STORAGE_ACCESS_KEY_ID: "signal-audit-local",
      STORAGE_SECRET_ACCESS_KEY: "local-only-storage-password"
    }
  };
}

function hostedEnvironment(appEnv) {
  requireHostedControls(appEnv, process.env);
  const sha = validateCommitSha(option("--sha") ?? process.env.DEPLOYMENT_COMMIT_SHA);
  const database = `signal_audit_${appEnv}`;
  return {
    project: `signal-audit-${appEnv}`,
    variables: {
      ...process.env,
      APP_ENV: appEnv,
      DEPLOYMENT_COMMIT_SHA: sha,
      POSTGRES_DB: database,
      DATABASE_URL: buildDatabaseUrl({
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        database
      }),
      DATABASE_SCHEMA: "public",
      STORAGE_REGION: process.env.STORAGE_REGION ?? "us-east-1",
      STORAGE_BUCKET: `signal-audit-${appEnv}`,
      WEB_BIND_ADDRESS: process.env.WEB_BIND_ADDRESS ?? "127.0.0.1"
    }
  };
}

/**
 * The container Compose is already running for a service, found the way
 * Compose itself finds it. Rotation acts on a live environment rather than
 * deriving a deployment, so it deliberately does not load the Compose
 * project: review (#86) noted that a `docker compose exec` re-parses
 * runtime.yml, and a full parse demands every deployment variable --
 * DATABASE_URL, SESSION_SECRET and the rest -- none of which a rotation
 * has or needs. Whether a given Compose version interpolates strictly for
 * `exec` is a version detail this path should not depend on.
 */
function runningContainerId(project, service) {
  const result = spawnSync(
    "docker",
    [
      "ps",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      `label=com.docker.compose.service=${service}`
    ],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ps failed with status ${result.status}: ${result.stderr.trim()}`);
  }
  const ids = result.stdout.split("\n").filter((id) => id.trim() !== "");
  if (ids.length !== 1) {
    throw new Error(`Expected one running ${service} container in ${project}, found ${ids.length}`);
  }
  return ids[0].trim();
}

/**
 * AF-94: rotating POSTGRES_PASSWORD alone never reaches the database --
 * Postgres only applies it while initialising an empty data directory, and
 * staging/production keep a persistent volume. This authenticates with the
 * outgoing password (POSTGRES_PASSWORD_PREVIOUS) against the already-running
 * postgres container and issues the ALTER ROLE that makes the role's actual
 * password match the secret being rotated in. Run it, then redeploy with
 * `up` so migrate/web/worker pick up the new value.
 *
 * The statement is sent on psql's stdin, and the outgoing password is
 * forwarded to the container via a bare `-e PGPASSWORD` (Docker reads the
 * value from this process's own environment) rather than a flag value, so
 * neither password is ever written into a process's argv.
 *
 * `-h 127.0.0.1` is load-bearing: psql defaults to the Unix socket, where
 * the image's pg_hba rules can admit a local connection without a password,
 * so a rotation would report success having never checked
 * POSTGRES_PASSWORD_PREVIOUS -- and would happily run against an
 * environment whose outgoing password is not the one being rotated out.
 * Over TCP the connection is subject to the image's host auth method, so a
 * wrong outgoing password fails here instead of silently succeeding.
 */
function rotatePassword(appEnv) {
  requireHostedControls(appEnv, process.env);
  const { previousPassword, nextPassword } = requireRotationControls(process.env);
  const user = process.env.POSTGRES_USER;
  const database = `signal_audit_${appEnv}`;
  const container = runningContainerId(`signal-audit-${appEnv}`, "postgres");
  const statement = buildAlterRolePasswordStatement(user, nextPassword);
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGPASSWORD",
      container,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      "127.0.0.1",
      "-U",
      user,
      "-d",
      database
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, PGPASSWORD: previousPassword },
      input: statement,
      stdio: ["pipe", "inherit", "inherit"]
    }
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`password rotation for ${appEnv} failed with status ${result.status}`);
  }
  console.log(
    `Rotated ${user}@${appEnv} to the password in POSTGRES_PASSWORD. Run 'up' to redeploy migrate/web/worker with it, then drop POSTGRES_PASSWORD_PREVIOUS from the secret store.`
  );
}

function startEnvironment(environment, { local = false, seed = false } = {}) {
  runDocker(environment.project, environment.variables, ["up", "-d", "postgres", "storage"], local);
  runDocker(environment.project, environment.variables, ["run", "--rm", "storage-init"], local);
  runDocker(environment.project, environment.variables, ["run", "--rm", "migrate"], local);
  if (seed) {
    runDocker(
      environment.project,
      environment.variables,
      ["--profile", "tools", "run", "--rm", "seed"],
      local
    );
  }
}

function deployEnvironment(environment, seed) {
  startEnvironment(environment, { seed });
  runDocker(environment.project, environment.variables, ["up", "-d", "--build", "web", "worker"]);
}

function previewStatePath(pr) {
  return path.join(previewDirectory, `pr-${pr}.json`);
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function stopPreview(state, removeState = true) {
  runDocker(state.project, state.variables, ["down", "--volumes", "--remove-orphans"]);
  if (removeState) fs.rmSync(previewStatePath(state.pr), { force: true });
}

function upPreview() {
  const pr = validatePullRequestNumber(option("--pr"));
  const statePath = previewStatePath(pr);
  if (fs.existsSync(statePath)) stopPreview(readState(statePath));
  const state = derivePreviewEnvironment(pr, option("--sha"));
  fs.mkdirSync(previewDirectory, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  deployEnvironment(state, true);
  console.log(`Preview ${state.pr} deployed from ${state.sha}: ${state.url}`);
}

function downPreview() {
  const pr = validatePullRequestNumber(option("--pr"));
  const statePath = previewStatePath(pr);
  if (!fs.existsSync(statePath)) {
    console.log(`Preview ${pr} already absent`);
    return;
  }
  stopPreview(readState(statePath));
  console.log(`Preview ${pr} removed`);
}

function sweepPreviews() {
  const ttlHours = Number(option("--ttl-hours") ?? process.env.PREVIEW_TTL_HOURS ?? "72");
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error("TTL must be positive");
  if (!fs.existsSync(previewDirectory)) return;
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1_000;
  for (const file of fs.readdirSync(previewDirectory)) {
    if (!/^pr-[1-9][0-9]*\.json$/u.test(file)) continue;
    const state = readState(path.join(previewDirectory, file));
    if (Date.parse(state.createdAt) < cutoff) {
      stopPreview(state);
      console.log(`Removed stale preview ${state.pr}`);
    }
  }
}

const [scope, action] = process.argv.slice(2, 4);

if (scope === "local") {
  const environment = localEnvironment();
  if (action === "up") startEnvironment(environment, { local: true });
  else if (action === "down") {
    assertDestructiveEnvironmentAllowed("development", "local teardown");
    runDocker(environment.project, environment.variables, ["down", "--remove-orphans"], true);
  } else if (action === "reset") {
    assertDestructiveEnvironmentAllowed("development", "local reset");
    runDocker(environment.project, environment.variables, ["down", "--volumes", "--remove-orphans"], true);
    startEnvironment(environment, { local: true, seed: true });
  } else if (action === "migrate") {
    runDocker(environment.project, environment.variables, ["run", "--rm", "migrate"], true);
  } else if (action === "seed") {
    runDocker(environment.project, environment.variables, ["--profile", "tools", "run", "--rm", "seed"], true);
  } else throw new Error("Expected local up|down|reset|migrate|seed");
} else if (scope === "preview") {
  if (action === "up") upPreview();
  else if (action === "down") downPreview();
  else if (action === "sweep") sweepPreviews();
  else throw new Error("Expected preview up|down|sweep");
} else if (scope === "staging" || scope === "production") {
  if (action === "up") deployEnvironment(hostedEnvironment(scope), scope === "staging");
  else if (action === "rotate-password") rotatePassword(scope);
  else throw new Error("Expected staging or production up|rotate-password");
} else {
  throw new Error("Expected local, preview, staging, or production command scope");
}
