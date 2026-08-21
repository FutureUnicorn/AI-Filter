import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDestructiveEnvironmentAllowed,
  derivePreviewEnvironment,
  requireHostedControls,
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
  return {
    project: `signal-audit-${appEnv}`,
    variables: {
      ...process.env,
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
  if (action !== "up") throw new Error("Hosted environments support only controlled up");
  deployEnvironment(hostedEnvironment(scope), scope === "staging");
} else {
  throw new Error("Expected local, preview, staging, or production command scope");
}
