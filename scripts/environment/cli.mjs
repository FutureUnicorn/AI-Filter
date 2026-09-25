import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireBackupControls } from "../backups/model.mjs";

import {
  assertDestructiveEnvironmentAllowed,
  derivePreviewEnvironment,
  requireHostedControls,
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
  const backup = requireBackupControls(appEnv, process.env);
  const sha = validateCommitSha(option("--sha") ?? process.env.DEPLOYMENT_COMMIT_SHA);
  return {
    project: `signal-audit-${appEnv}`,
    backupEnabled: backup.enabled,
    variables: {
      ...process.env,
      ...backup.variables,
      APP_ENV: appEnv,
      DEPLOYMENT_COMMIT_SHA: sha,
      POSTGRES_DB: `signal_audit_${appEnv}`,
      DATABASE_SCHEMA: "public",
      STORAGE_REGION: process.env.STORAGE_REGION ?? "us-east-1",
      STORAGE_BUCKET: `signal-audit-${appEnv}`,
      WEB_BIND_ADDRESS: process.env.WEB_BIND_ADDRESS ?? "127.0.0.1"
    }
  };
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
    if (action !== "up") throw new Error("Hosted environments support only controlled up");
    deployEnvironment(hostedEnvironment(scope), scope === "staging");
  } else {
    throw new Error("Expected local, preview, staging, or production command scope");
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
