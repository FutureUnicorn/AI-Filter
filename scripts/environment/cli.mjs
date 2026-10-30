import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireBackupControls } from "../backups/model.mjs";

import {
  assertDestructiveEnvironmentAllowed,
  buildAlterRolePasswordStatement,
  buildDatabaseUrl,
  buildRotationCommand,
  classifyRotationFailure,
  derivePreviewEnvironment,
  requireHostedControls,
  requireRotationControls,
  rotationFailureMessage,
  resolvePreviewStateDirectory,
  validateCommitSha,
  validatePullRequestNumber
} from "./model.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// AF-93 PR #85 review (Copilot): the deploy job checks out the PR's own,
// untrusted head SHA (it has to, to build that revision's Dockerfile), and
// that checkout must keep clean: false so it doesn't wipe this state
// (finding 1). Left inside the repository root, that combination handed the
// untrusted checkout read access to every OTHER preview's already-generated
// database and storage credentials the moment it ran cli.mjs -- a real
// escalation of the runner-isolation gap (tracked separately: untrusted code
// executing on a persistent, reused self-hosted runner), not just a
// hypothetical one, since .gitignore itself documents the exact path to
// look in. PREVIEW_STATE_DIRECTORY moves the credential store to a fixed
// location outside the git working tree entirely, so it is never part of
// what any checkout (trusted or not) contains. The workflow points every
// job (deploy, cleanup, sweep) at the same absolute, runner-persistent path;
// falling back to an in-repo `.runtime/` when unset keeps local, manual
// `pnpm preview:*` usage on a developer's own machine unchanged.
//
// Resolution itself lives in model.mjs (resolvePreviewStateDirectory) so a
// test can assert the resolved PATH directly, not just that this file
// mentions the env var's name (PR #85 review, REV-002).
const runtimeDirectory = resolvePreviewStateDirectory(repositoryRoot);
const previewDirectory = path.join(runtimeDirectory, "previews");
const composeFile = path.join(repositoryRoot, "infra/compose/runtime.yml");
const localComposeFile = path.join(repositoryRoot, "infra/compose/local.yml");
const localEnvFile = path.join(repositoryRoot, ".env.local");

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function runDocker(project, variables, arguments_, local = false) {
  const files = ["compose"];

  if (local) {
    if (!fs.existsSync(localEnvFile)) {
      throw new Error("Missing .env.local. Copy .env.example to .env.local before running local infrastructure.");
    }
    files.push("--env-file", localEnvFile);
  }

  files.push("-f", composeFile);

  if (local) {
    files.push("-f", localComposeFile);
  }

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

// Exported so a test can assert the environment these actually EMIT, rather
// than that this file mentions buildDatabaseUrl (#86 review, REV-008).
// runtime.yml demands a pre-built, percent-encoded DATABASE_URL; the only
// thing that satisfies that demand is these call sites, and a reconciliation
// that dropped one would leave every other check green.
export function localEnvironment() {
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

export function hostedEnvironment(appEnv) {
  requireHostedControls(appEnv, process.env);
  const backup = requireBackupControls(appEnv, process.env);
  const sha = validateCommitSha(option("--sha") ?? process.env.DEPLOYMENT_COMMIT_SHA);
  const database = `signal_audit_${appEnv}`;
  return {
    project: `signal-audit-${appEnv}`,
    backupEnabled: backup.enabled,
    variables: {
      ...process.env,
      ...backup.variables,
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

function dockerLines(arguments_, description) {
  const result = spawnSync("docker", arguments_, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${description} failed with status ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

function only(lines, description) {
  if (lines.length !== 1) throw new Error(`Expected one ${description}, found ${lines.length}`);
  return lines[0];
}

/**
 * Where a hosted environment's database can be reached, found the way
 * Compose itself finds it. Rotation acts on a live environment rather than
 * deriving a deployment, so it deliberately does not load the Compose
 * project: review (#86) noted that a `docker compose exec` re-parses
 * runtime.yml, and a full parse demands every deployment variable --
 * DATABASE_URL, SESSION_SECRET and the rest -- none of which a rotation
 * has or needs. Whether a given Compose version interpolates strictly for
 * `exec` is a version detail this path should not depend on.
 *
 * The image is read from the running container rather than hard-coded, so
 * the psql client cannot drift from the server runtime.yml pins.
 */
function hostedDatabaseAccess(project) {
  const container = only(
    dockerLines(
      [
        "ps",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        "label=com.docker.compose.service=postgres"
      ],
      "docker ps"
    ),
    `running postgres container in ${project}`
  );
  const network = only(
    dockerLines(
      [
        "network",
        "ls",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        "label=com.docker.compose.network=private"
      ],
      "docker network ls"
    ),
    `private network in ${project}`
  );
  const image = only(
    dockerLines(["inspect", "--format", "{{.Config.Image}}", container], "docker inspect"),
    `image for the postgres container in ${project}`
  );
  return { network, image };
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
 * The statement is sent on psql's stdin; the outgoing and incoming passwords
 * are forwarded by environment-variable name rather than flag values, so
 * neither is written into argv. psql performs literal quoting from its
 * environment variable, and stderr is captured instead of inherited to
 * prevent query diagnostics from reaching terminal/CI output. See
 * buildRotationCommand for why this runs on the private network.
 *
 * Rerunning after a successful rotation is a no-op rather than an error
 * (#86, REV-003): once the outgoing password is genuinely checked, a retry
 * would otherwise fail authentication indistinguishably from having typed
 * the wrong one -- on a credential path, mid-incident.
 */
/**
 * @param {{
 *   appEnv: string,
 *   user: string,
 *   previousPassword: string,
 *   nextPassword: string,
 *   command: string[],
 *   environment?: NodeJS.ProcessEnv,
 *   execute?: (file: string, args: string[], options: { cwd: string, env: NodeJS.ProcessEnv, input: string, encoding: "utf8" }) => { status: number | null, error?: Error, stdout?: string, stderr?: string },
 *   log?: (message: string) => void
 * }} options
 */
export function runPasswordRotation({
  appEnv,
  user,
  previousPassword,
  nextPassword,
  command,
  environment = process.env,
  execute = spawnSync,
  log = console.log
}) {
  const run = (extraEnvironment, input) =>
    execute("docker", command, {
      cwd: repositoryRoot,
      env: { ...environment, ...extraEnvironment },
      input,
      encoding: "utf8"
    });

  const probe = run({ PGPASSWORD: nextPassword }, "SELECT 1;\n");
  if (probe.error === undefined && probe.status === 0) {
    log(`${user}@${appEnv} already accepts the password in POSTGRES_PASSWORD; nothing to rotate. Continue from the redeploy step.`);
    return;
  }

  const probeFailure = classifyRotationFailure(probe);
  if (probeFailure !== "authentication") {
    throw new Error(rotationFailureMessage(appEnv, probeFailure, probe.status));
  }

  const result = run(
    { PGPASSWORD: previousPassword, SIGNAL_AUDIT_NEXT_PASSWORD: nextPassword },
    buildAlterRolePasswordStatement(user)
  );
  if (result.error !== undefined || result.status !== 0) {
    const failure = classifyRotationFailure(result);
    throw new Error(rotationFailureMessage(appEnv, failure, result.status));
  }
  log(`Rotated ${user}@${appEnv} to the password in POSTGRES_PASSWORD. Services fail authentication until you redeploy with 'up'.`);
}

function rotatePassword(appEnv) {
  requireHostedControls(appEnv, process.env);
  const { previousPassword, nextPassword } = requireRotationControls(process.env);
  const user = process.env.POSTGRES_USER;
  const database = `signal_audit_${appEnv}`;
  const { network, image } = hostedDatabaseAccess(`signal-audit-${appEnv}`);
  const command = buildRotationCommand({ image, network, user, database });
  runPasswordRotation({ appEnv, user, previousPassword, nextPassword, command });
}

function startEnvironment(environment, { local = false, seed = false } = {}, dockerRunner = runDocker) {
  dockerRunner(environment.project, environment.variables, ["up", "-d", "postgres", "storage"], local);
  dockerRunner(environment.project, environment.variables, ["run", "--rm", "storage-init"], local);
  dockerRunner(environment.project, environment.variables, ["run", "--rm", "migrate"], local);
  if (seed) {
    dockerRunner(
      environment.project,
      environment.variables,
      ["--profile", "tools", "run", "--rm", "seed"],
      local
    );
  }
}

export function deployEnvironment(environment, seed, dockerRunner = runDocker) {
  if (environment.backupEnabled !== true) {
    dockerRunner(environment.project, environment.variables, [
      "--profile",
      "backups",
      "rm",
      "--stop",
      "--force",
      "backup"
    ]);
  }
  startEnvironment(environment, { seed }, dockerRunner);
  if (environment.backupEnabled === true) {
    dockerRunner(environment.project, environment.variables, [
      "--profile",
      "backups",
      "run",
      "--build",
      "--rm",
      "backup-init"
    ]);
    dockerRunner(environment.project, environment.variables, [
      "--profile",
      "backups",
      "up",
      "-d",
      "--build",
      "web",
      "worker",
      "backup"
    ]);
    return;
  }
  dockerRunner(environment.project, environment.variables, ["up", "-d", "--build", "web", "worker"]);
}

function previewStatePath(pr) {
  return path.join(previewDirectory, `pr-${pr}.json`);
}

function readState(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  // Teardown replays these variables, and runtime.yml now requires
  // DATABASE_URL, which states written before AF-94 do not carry (#86,
  // REV-005). Deriving it here keeps previews deployed from the old code
  // tearable down, rather than resting on whether a given Compose version
  // enforces `:?` on `down`.
  const variables = state.variables;
  if (variables !== undefined && variables.DATABASE_URL === undefined) {
    variables.DATABASE_URL = buildDatabaseUrl({
      user: variables.POSTGRES_USER,
      password: variables.POSTGRES_PASSWORD,
      database: variables.POSTGRES_DB
    });
  }
  return state;
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

function main() {
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
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
