import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("runtime infrastructure is isolated, private, bounded, and pinned", () => {
  const compose = read("infra/compose/runtime.yml");
  assert.match(compose, /postgres:17\.10-alpine3\.23/u);
  assert.match(compose, /minio\/minio:RELEASE\.2025-09-07T16-13-09Z/u);
  assert.match(compose, /internal: true/u);
  assert.match(compose, /mem_limit:/u);
  assert.match(compose, /cpus:/u);
  assert.match(compose, /no-new-privileges:true/u);
  assert.match(compose, /test "\$\$APP_ENV" != production/u);
});

/**
 * AF-97 review #88, REV-001 (blocking).
 *
 * `pnpm bootstrap:owner` is the only way to create a deployment's first
 * owner, and it could not be run against the deployment this repo ships.
 * runtime.Dockerfile copied `apps` and `packages` and not `scripts`, so the
 * script was absent from both runtime stages; and `postgres` sits only on
 * the `private` network, which is `internal: true` with no published port,
 * so there was no path to the database from outside the project either.
 * Every documented way in was closed, for the one ticket whose whole purpose
 * is that a deployment can be entered.
 *
 * Asserted here rather than left to a README instruction, because a README
 * cannot fail.
 */
test("the first owner can actually be created inside the shipped deployment", () => {
  const dockerfile = read("infra/docker/runtime.Dockerfile");
  assert.match(
    dockerfile,
    /^COPY scripts scripts$/mu,
    "the runtime image must carry scripts/, or bootstrap:owner cannot run in it"
  );

  const compose = read("infra/compose/runtime.yml");
  const bootstrapService = /^ {2}bootstrap:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  assert.ok(bootstrapService, "expected a bootstrap service so the first owner can be created in-cluster");

  assert.match(
    bootstrapService!,
    /entrypoint: \["node", "scripts\/environment\/bootstrap\.mjs"\]/u,
    "the bootstrap service must run the bootstrap script"
  );
  assert.match(
    bootstrapService!,
    /networks: \[private\]/u,
    "bootstrap must reach postgres on the internal network, which is the whole reason it runs in-cluster"
  );
  assert.match(bootstrapService!, /profiles: \[tools\]/u, "bootstrap must not start with the stack");
  assert.match(
    bootstrapService!,
    /<<: \*runtime-environment/u,
    "bootstrap must use the deployment's own configuration, not a hand-assembled one"
  );

  // Unlike `seed`, deliberately NOT refused in production: a production
  // deployment is precisely where somebody has to be the first owner. If this
  // ever gains the guard, the hosted entry point closes again.
  assert.doesNotMatch(
    bootstrapService!,
    /APP_ENV" != production/u,
    "bootstrap must not refuse production, which is where a first owner is most needed"
  );
});

test("fixtures are unmistakably synthetic", () => {
  const fixture = read("tests/fixtures/environment/synthetic.sql");
  assert.match(fixture, /candidate-001@example\.test/u);
  assert.match(fixture, /synthetic/u);
  assert.doesNotMatch(fixture, /@gmail\.com|@outlook\.com/u);
});

test("policy exception does not authorize a hosted product", () => {
  const policy = read("docs/PRODUCT_BOUNDARY.md");
  assert.match(policy, /AF-11 synthetic infrastructure validation exception/u);
  assert.match(policy, /MUST NOT process real applicant or employer data/u);
  assert.match(policy, /MUST NOT be used by customers or design partners/u);
  assert.match(policy, /No numbered\s+policy invariant is weakened or suspended/u);
});

test("hosted environment examples contain references, never usable secrets", () => {
  for (const file of [
    "infra/environments/staging.env.example",
    "infra/environments/production.env.example"
  ]) {
    const contents = read(file);
    assert.match(contents, /COST_CONTROL_REFERENCE=/u);
    assert.match(contents, /ADMIN_AUDIT_REFERENCE=/u);
    assert.match(contents, /<.*>/u);
    assert.doesNotMatch(contents, /sk-[A-Za-z0-9]/u);
  }
});

test("server secrets cannot be exposed through Next public environment variables", () => {
  const config = read("packages/config/src/index.ts");
  const healthRoute = read("apps/web/src/app/health/environment/route.ts");
  assert.doesNotMatch(config, /NEXT_PUBLIC_/u);
  assert.doesNotMatch(healthRoute, /environment:\s*config(?:[,}\s]|$)/u);
  assert.doesNotMatch(healthRoute, /Response\.json\(\s*config/u);
  assert.match(healthRoute, /publicEnvironmentSummary/u);
});

test("preview lifecycle is green-SHA scoped with close and TTL cleanup", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  assert.match(workflow, /workflow_run:/u);
  assert.match(workflow, /conclusion == 'success'/u);
  assert.match(workflow, /head_repository\.full_name == github\.repository/u);
  assert.match(workflow, /pull_request_target:/u);
  assert.match(workflow, /types: \[closed\]/u);
  assert.match(workflow, /schedule:/u);
  assert.match(workflow, /preview sweep/u);
});

test("local Compose explicitly loads .env.local without affecting hosted commands", () => {
  const cli = read("scripts/environment/cli.mjs");

  assert.match(cli, /const localEnvFile = path\.join\(repositoryRoot, "\.env\.local"\);/u);
  assert.match(cli, /if \(!fs\.existsSync\(localEnvFile\)\) \{[\s\S]*?Missing \.env\.local\. Copy \.env\.example to \.env\.local before running local infrastructure\.[\s\S]*?\}/u);
  assert.match(cli, /if \(local\) \{[\s\S]*?files\.push\("--env-file", localEnvFile\);[\s\S]*?\}/u);
  assert.match(cli, /dockerRunner\(environment\.project, environment\.variables, \["up", "-d", "postgres", "storage"\], local\);/u);
  assert.match(cli, /dockerRunner\(environment\.project, environment\.variables, \["up", "-d", "--build", "web", "worker"\]\);/u);
});

test("staging and production deploy only exact green revisions", () => {
  const staging = read(".github/workflows/staging-environment.yml");
  const production = read(".github/workflows/production-gate.yml");
  assert.match(staging, /branches: \[develop\]/u);
  assert.match(staging, /conclusion == 'success'/u);
  assert.match(staging, /git rev-parse HEAD/u);
  assert.match(production, /needs: eligibility/u);
  assert.match(production, /PRODUCTION_VALIDATION_ONLY: "true"/u);
  assert.match(production, /git rev-parse HEAD/u);
  assert.doesNotMatch(production, /workflow_dispatch/u);
});

/**
 * PR #83 review, REV-003. Five variables the code requires were absent from
 * .env.example: SESSION_SECRET, PUBLIC_APP_ORIGIN and the three
 * MAGIC_LINK_EMAIL_* values. A developer copying the template got a server
 * that booted, passed the environment health check, and then threw on every
 * authenticated request.
 *
 * Reading the names out of the source rather than keeping a list here is the
 * point: a hand-kept list is exactly what drifted. Any variable a future
 * ticket adds to the config schema, or reads from process.env in the web app's
 * own library code, has to appear in the template or this fails.
 */
test("every environment variable the code requires appears in .env.example", () => {
  const template = new Set(
    read(".env.example")
      .split("\n")
      .map((line) => /^([A-Z][A-Z0-9_]*)=/u.exec(line.trim())?.[1])
      .filter((name): name is string => name !== undefined)
  );

  // Keys of the config schema's z.object, which is what loadEnvironmentConfig
  // parses and therefore what every service needs.
  const configSource = read("packages/config/src/index.ts");
  const schemaKeys = [...configSource.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gmu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);

  // Plus anything the web app reads straight from process.env, which is how
  // SESSION_SECRET escaped the schema in the first place.
  const webSecrets = [...read("apps/web/src/lib/session.ts").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/gu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);

  // PREVIEW_* are injected by the preview pipeline per deployment, not copied
  // from a template, so a placeholder would be misleading rather than helpful.
  const pipelineInjected = new Set(["PREVIEW_ID", "PREVIEW_COMMIT_SHA"]);

  const required = [...new Set([...schemaKeys, ...webSecrets])].filter((name) => !pipelineInjected.has(name)).sort();
  assert.ok(required.length > 10, `expected to discover the real variable list, found ${required.length}`);

  const missing = required.filter((name) => !template.has(name));
  assert.deepEqual(
    missing,
    [],
    `these variables are required by the code but absent from .env.example, so a developer following it gets a ` +
      `server that starts and then fails:\n${missing.join("\n")}`
  );
});

/**
 * PR #83 review, REV-013. Compose's shared x-runtime-environment carried
 * neither SESSION_SECRET nor PUBLIC_APP_ORIGIN/MAGIC_LINK_EMAIL_*, so
 * `docker compose up` started a web container that instrumentation.ts (REV-003)
 * then killed before it could accept a request, and a hosted deployment
 * (APP_ENV=staging/production) failed packages/config's loadEnvironmentConfig
 * for the same reason .env.example was once missing them.
 *
 * SESSION_SECRET belongs to the web service specifically, not the shared
 * block: apps/worker loads the same config schema and never signs a session,
 * so requiring the secret there would fail worker boot over a value it never
 * reads (see instrumentation.ts).
 */
test("compose passes the web service its session secret and the shared hosted config vars", () => {
  const compose = read("infra/compose/runtime.yml");

  const runtimeEnvironmentBlock = /x-runtime-environment:[\s\S]*?(?=\nservices:)/u.exec(compose)?.[0];
  assert.ok(runtimeEnvironmentBlock, "expected an x-runtime-environment anchor block");
  for (const name of [
    "PUBLIC_APP_ORIGIN",
    "MAGIC_LINK_EMAIL_ENDPOINT",
    "MAGIC_LINK_EMAIL_API_KEY",
    "MAGIC_LINK_EMAIL_FROM"
  ]) {
    assert.match(
      runtimeEnvironmentBlock!,
      new RegExp(`${name}: \\$\\{${name}:-\\}`, "u"),
      `${name} must be in the shared runtime environment so hosted web and worker config can load`
    );
  }
  assert.doesNotMatch(
    runtimeEnvironmentBlock!,
    /SESSION_SECRET/u,
    "SESSION_SECRET must not be shared with the worker, which never signs a session"
  );

  const webService = /^ {2}web:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  assert.ok(webService, "expected a web service block");
  assert.match(
    webService!,
    /SESSION_SECRET: \$\{SESSION_SECRET:\?SESSION_SECRET is required\}/u,
    "the web service must receive a required SESSION_SECRET"
  );

  const workerService = /^ {2}worker:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  assert.ok(workerService, "expected a worker service block");
  assert.doesNotMatch(workerService!, /SESSION_SECRET/u, "the worker must not require a session secret it never reads");
});

test("compose maps service-specific Sentry projects and a shared explicit sample rate", () => {
  const compose = read("infra/compose/runtime.yml");
  const runtimeEnvironmentBlock = /x-runtime-environment:[\s\S]*?(?=\nservices:)/u.exec(compose)?.[0];
  assert.ok(runtimeEnvironmentBlock);
  assert.match(runtimeEnvironmentBlock!, /SENTRY_TRACES_SAMPLE_RATE: \$\{SENTRY_TRACES_SAMPLE_RATE:-\}/u);

  const webService = /^ {2}web:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  const workerService = /^ {2}worker:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  assert.ok(webService);
  assert.ok(workerService);
  assert.match(webService!, /SENTRY_DSN: \$\{SENTRY_WEB_DSN:-\}/u);
  assert.match(workerService!, /SENTRY_DSN: \$\{SENTRY_WORKER_DSN:-\}/u);
  assert.doesNotMatch(webService!, /SENTRY_WORKER_DSN/u);
  assert.doesNotMatch(workerService!, /SENTRY_WEB_DSN/u);
});

test("compose keeps provider secrets worker-only and gives the unexposed worker outbound access", () => {
  const compose = read("infra/compose/runtime.yml");
  const runtimeEnvironmentBlock = /x-runtime-environment:[\s\S]*?(?=\nservices:)/u.exec(compose)?.[0];
  const webService = /^ {2}web:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  const workerService = /^ {2}worker:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  assert.ok(runtimeEnvironmentBlock);
  assert.ok(webService);
  assert.ok(workerService);
  assert.match(runtimeEnvironmentBlock!, /WORKER_MAX_ATTEMPTS: \$\{WORKER_MAX_ATTEMPTS:-3\}/u);
  assert.doesNotMatch(runtimeEnvironmentBlock!, /OPENAI_API_KEY/u);
  assert.doesNotMatch(webService!, /OPENAI_API_KEY|WORKER_PROCESSING_ENABLED/u);
  for (const name of [
    "WORKER_PROCESSING_ENABLED",
    "WORKER_INSTANCE_ID",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_ESCALATION_MODEL",
    "INFERENCE_MAX_TOKENS_PER_PERIOD",
    "INFERENCE_ALERT_THRESHOLD_RATIO",
    "INFERENCE_BUDGET_PERIOD"
  ]) {
    assert.match(workerService!, new RegExp(`${name}:`, "u"));
  }
  assert.match(workerService!, /networks: \[public, private\]/u);
  assert.doesNotMatch(workerService!, /^ {4}ports:/mu, "the worker needs egress, not a host-exposed port");
});

test("the web server refuses to start without a session secret", () => {
  // REV-003's other half. Documenting SESSION_SECRET is not enough on its own:
  // read at request time, its absence is a 500 per request rather than a
  // failure to boot, and the health check reports healthy throughout. Next.js
  // calls register() once and waits for it before serving, so throwing there
  // is what makes absence a startup failure.
  const instrumentation = read("apps/web/src/instrumentation.ts");
  assert.match(instrumentation, /export (?:async )?function register\(/u, "Next.js only calls a function named register");
  assert.match(instrumentation, /SESSION_SECRET/u);
  assert.match(instrumentation, /throw new Error/u, "it has to throw; logging a warning still serves requests");
});

test("hosted backups leave application credentials isolated and use an off-host encrypted target", () => {
  const compose = read("infra/compose/runtime.yml");
  const backupService = /^ {2}backup:[\s\S]*?(?=\n {2}\S|\nnetworks:)/mu.exec(compose)?.[0];
  const backupInitService = /^ {2}backup-init:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  const backupEnvironment = /x-backup-environment:[\s\S]*?(?=\nservices:)/u.exec(compose)?.[0];
  const webService = /^ {2}web:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  const workerService = /^ {2}worker:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  assert.ok(backupService);
  assert.ok(backupInitService);
  assert.ok(backupEnvironment);
  assert.ok(webService);
  assert.ok(workerService);

  assert.match(backupService!, /profiles: \[backups\]/u);
  assert.match(backupService!, /networks: \[public, private\]/u);
  assert.match(backupService!, /read_only: true/u);
  assert.match(backupService!, /cap_drop: \["ALL"\]/u);
  assert.match(backupService!, /no-new-privileges:true/u);
  assert.match(backupService!, /signal-audit-backup", "health/u);
  assert.match(backupService!, /\/tmp:size=16m/u);
  assert.match(backupService!, /backup-work:\/var\/lib\/signal-audit-backup/u);
  assert.doesNotMatch(
    backupService!,
    /BACKUP_TEMP_SIZE/u,
    "database archives must not share the container memory limit through tmpfs"
  );
  assert.match(compose, /^ {2}backup-work: \{\}$/mu);
  const backupDockerfile = read("infra/docker/backup.Dockerfile");
  assert.match(backupDockerfile, /chown 70:70 \/var\/lib\/signal-audit-backup/u);
  assert.match(backupDockerfile, /chmod 0700 \/var\/lib\/signal-audit-backup/u);
  assert.match(backupEnvironment!, /BACKUP_CONTROL_OWNER:/u);
  assert.match(backupEnvironment!, /BACKUP_ENCRYPTION_REFERENCE:/u);
  assert.doesNotMatch(backupEnvironment!, /BACKUP_(?:ADMIN|WRITER)_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/u);
  assert.match(backupInitService!, /BACKUP_ACCESS_KEY_ID: \$\{BACKUP_ADMIN_ACCESS_KEY_ID:-\}/u);
  assert.match(backupInitService!, /BACKUP_SECRET_ACCESS_KEY: \$\{BACKUP_ADMIN_SECRET_ACCESS_KEY:-\}/u);
  assert.doesNotMatch(backupInitService!, /BACKUP_WRITER_/u);
  assert.match(backupService!, /BACKUP_ACCESS_KEY_ID: \$\{BACKUP_WRITER_ACCESS_KEY_ID:-\}/u);
  assert.match(backupService!, /BACKUP_SECRET_ACCESS_KEY: \$\{BACKUP_WRITER_SECRET_ACCESS_KEY:-\}/u);
  assert.doesNotMatch(backupService!, /BACKUP_ADMIN_/u);
  assert.doesNotMatch(webService!, /BACKUP_(?:ADMIN|WRITER|ACCESS|SECRET)/u);
  assert.doesNotMatch(workerService!, /BACKUP_(?:ADMIN|WRITER|ACCESS|SECRET)/u);

  const script = read("scripts/backups/backup.sh");
  assert.match(script, /BACKUP_ENDPOINT must use https/u);
  assert.match(script, /--enc-s3/u);
  assert.match(script, /mc --quiet mirror[\s\S]*?--overwrite[\s\S]*?--remove/u);
  assert.equal((script.match(/mirror_storage "\$backup_id"/gu) ?? []).length, 2);
  assert.match(script, /pg_dump[\s\S]*?--format=custom/u);
  assert.match(script, /pg_restore --list/u);
  assert.match(script, /sha256sum/u);
  assert.match(script, /dump_file="\$BACKUP_WORK_DIR\/\$backup_id\.dump"/u);
  assert.match(script, /checksum_output="\$\(sha256sum "\$dump_file"\)"/u);
  assert.match(script, /is_lower_hex_length "\$database_sha256" 64/u);
  assert.doesNotMatch(
    script,
    /sha256sum[^\n]*\|/u,
    "checksum command failure must not be hidden by a successful pipeline tail"
  );
  assert.match(script, /nonce_words="\$\(od -An -N4 -tx1 \/dev\/urandom\)"/u);
  assert.match(script, /is_lower_hex_length "\$nonce" 8/u);
  assert.match(script, /trap 'cleanup_run_files' 0/u);
  assert.match(script, /trap 'handle_shutdown' INT TERM/u);
  assert.match(script, /kill -TERM "\$active_pid"/u);
  assert.match(script, /run_interruptible pg_dump/u);
  assert.match(script, /run_interruptible pg_restore/u);
  assert.match(script, /run_interruptible mc --quiet mirror/u);
  assert.equal((script.match(/run_interruptible mc --quiet cp/gu) ?? []).length, 4);
  assert.match(
    script,
    /"target\/\$BACKUP_BUCKET\/\$database_history_key" "target\/\$BACKUP_BUCKET\/\$database_latest_key"/u,
    "the recovery slot must be copied inside the destination rather than uploaded twice from the host"
  );
  assert.match(script, /cleanup_orphaned_dumps/u);
  assert.match(script, /run_once \|\| true/u);
  assert.doesNotMatch(
    script,
    /signal-audit-backup once/u,
    "the signal-owning shell must execute the run so its cleanup trap knows the active paths"
  );
  assert.match(script, /LAST_SUCCESS_FILE="\$BACKUP_WORK_DIR\/last-success-epoch"/u);
  assert.match(script, /seconds_until_next_run/u);
  assert.doesNotMatch(
    script,
    /\b(?:echo|printf)\b[^\n]*\$\{?(?:STORAGE|BACKUP)_SECRET_ACCESS_KEY/u,
    "secret values must never be written to backup logs"
  );
});

test("backup retention is reproducible and preserves current source objects", () => {
  const script = read("scripts/backups/backup.sh");
  assert.match(script, /mc --quiet version enable/u);
  assert.match(script, /mc --quiet ilm rule import/u);
  assert.match(script, /af68-database-history-retention/u);
  assert.match(script, /af68-database-latest-retention/u);
  assert.match(script, /af68-manifest-history-retention/u);
  assert.match(script, /af68-latest-manifest-history-retention/u);
  assert.match(script, /af68-storage-history-retention/u);
  assert.match(script, /NoncurrentVersionExpiration/u);
  assert.match(script, /ExpiredObjectDeleteMarker/u);

  const storageRule =
    /"ID": "af68-storage-history-retention"[\s\S]*?\n {4}\}/u.exec(script)?.[0];
  assert.ok(storageRule);
  assert.doesNotMatch(
    storageRule!,
    /"Expiration": \{ "Days"/u,
    "current mirrored objects must not expire while they still exist in primary storage"
  );

  const latestDatabaseRule =
    /"ID": "af68-database-latest-retention"[\s\S]*?\n {4}\}/u.exec(script)?.[0];
  assert.ok(latestDatabaseRule);
  assert.doesNotMatch(latestDatabaseRule!, /"Expiration": \{ "Days"/u);
  assert.match(latestDatabaseRule!, /"NewerNoncurrentVersions": 1/u);
  assert.match(latestDatabaseRule!, /"Prefix": "\$APP_ENV\/database\/latest-"/u);
  assert.match(script, /database_latest_key="\$APP_ENV\/database\/latest-a\.dump"/u);
  assert.match(script, /database_latest_key="\$APP_ENV\/database\/latest-b\.dump"/u);
  assert.match(script, /latest_database_version_id="\$\(extract_version_id "\$latest_database_stat"\)"/u);
  assert.match(script, /versionId/u);

  for (const ruleId of ["af68-database-history-retention", "af68-manifest-history-retention"]) {
    const expiringRule = new RegExp(`"ID": "${ruleId}"[\\s\\S]*?\\n {4}\\}`, "u").exec(script)?.[0];
    assert.ok(expiringRule, `expected ${ruleId}`);
    assert.match(
      expiringRule!,
      /"NoncurrentVersionExpiration": \{ "NoncurrentDays": 1 \}/u,
      `${ruleId} must remove versions left behind when current objects expire`
    );
  }
});

test("hosted workflows pass backup policy as variables and credentials as secrets", () => {
  for (const file of [
    ".github/workflows/staging-environment.yml",
    ".github/workflows/production-gate.yml"
  ]) {
    const workflow = read(file);
    assert.match(workflow, /BACKUP_ENABLED: \$\{\{ vars\.BACKUP_ENABLED \}\}/u);
    assert.match(workflow, /BACKUP_INTERVAL_SECONDS: \$\{\{ vars\.BACKUP_INTERVAL_SECONDS \}\}/u);
    assert.match(workflow, /BACKUP_RETENTION_DAYS: \$\{\{ vars\.BACKUP_RETENTION_DAYS \}\}/u);
    for (const name of [
      "BACKUP_ADMIN_ACCESS_KEY_ID",
      "BACKUP_ADMIN_SECRET_ACCESS_KEY",
      "BACKUP_WRITER_ACCESS_KEY_ID",
      "BACKUP_WRITER_SECRET_ACCESS_KEY"
    ]) {
      assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`, "u"));
      assert.doesNotMatch(workflow, new RegExp(`${name}: \\$\\{\\{ vars\\.`, "u"));
    }
  }
});

test("hosted backup deployment builds and configures the exact backup image before starting it", () => {
  const cli = read("scripts/environment/cli.mjs");
  assert.match(
    cli,
    /"run",\s*"--build",\s*"--rm",\s*"backup-init"/u,
    "backup-init must not reuse a stale image from an earlier deployment"
  );
  assert.match(
    cli,
    /"up",\s*"-d",\s*"--build",\s*"web",\s*"worker",\s*"backup"/u
  );
  assert.match(
    cli,
    /"--profile",\s*"backups",\s*"rm",\s*"--stop",\s*"--force",\s*"backup"/u,
    "a disabled deploy must stop and remove an earlier backup container"
  );
});

test(
  "backup runtime rejects missing governance controls and invalid intervals before target access",
  { skip: process.platform === "win32" ? "POSIX shell behavior runs in Linux CI and container validation" : false },
  (t) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "af68-backup-validation-"));
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
    const binDirectory = path.join(temporaryDirectory, "bin");
    fs.mkdirSync(binDirectory);
    const mcPath = path.join(binDirectory, "mc");
    fs.writeFileSync(mcPath, '#!/bin/sh\nprintf \'called\\n\' >>"$MC_CALL_LOG"\n', { mode: 0o700 });

    const validEnvironment = {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      APP_ENV: "staging",
      DEPLOYMENT_COMMIT_SHA: "a".repeat(40),
      PGHOST: "postgres",
      PGDATABASE: "signal_audit_staging",
      PGUSER: "signal_audit_staging",
      PGPASSWORD: "database-secret-at-least-20",
      STORAGE_BUCKET: "signal-audit-staging",
      STORAGE_ACCESS_KEY_ID: "storage-access",
      STORAGE_SECRET_ACCESS_KEY: "storage-secret-at-least-20",
      BACKUP_ENDPOINT: "https://backups.example.test",
      BACKUP_REGION: "ap-south-1",
      BACKUP_BUCKET: "signal-audit-staging-backups",
      BACKUP_ACCESS_KEY_ID: "backup-admin",
      BACKUP_SECRET_ACCESS_KEY: "backup-admin-secret-at-least-20",
      BACKUP_INTERVAL_SECONDS: "86400",
      BACKUP_RETENTION_DAYS: "30",
      BACKUP_PATH_STYLE: "off",
      BACKUP_CONTROL_OWNER: "platform-operations",
      BACKUP_ENCRYPTION_REFERENCE: "kms://backup-provider/staging"
    };

    for (const [name, invalidValue] of [
      ["PGPASSWORD", ""],
      ["BACKUP_CONTROL_OWNER", ""],
      ["BACKUP_ENCRYPTION_REFERENCE", ""],
      ["BACKUP_INTERVAL_SECONDS", "0"]
    ] as const) {
      const callLog = path.join(temporaryDirectory, `${name}.calls`);
      const result = spawnSync(
        "sh",
        [path.join(repositoryRoot, "scripts/backups/backup.sh"), "configure"],
        {
          encoding: "utf8",
          env: { ...validEnvironment, [name]: invalidValue, MC_CALL_LOG: callLog }
        }
      );
      assert.equal(result.status, 2, `${name}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(name, "u"));
      assert.equal(fs.existsSync(callLog), false, `${name} must fail before mc can change the target`);
    }

    const workDirectory = path.join(temporaryDirectory, "work");
    fs.mkdirSync(workDirectory);
    fs.writeFileSync(path.join(workDirectory, "last-success-epoch"), "900\n");
    const datePath = path.join(binDirectory, "date");
    fs.writeFileSync(datePath, "#!/bin/sh\nprintf '1000\\n'\n", { mode: 0o700 });
    const functionsPath = path.join(temporaryDirectory, "backup-functions.sh");
    fs.writeFileSync(
      functionsPath,
      read("scripts/backups/backup.sh").replace(/\ncase "\$\{1-\}" in[\s\S]*$/u, "\n")
    );

    const schedule = spawnSync(
      "sh",
      ["-c", '. "$1"; BACKUP_INTERVAL_SECONDS=300; seconds_until_next_run', "sh", functionsPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          BACKUP_WORK_DIR: workDirectory
        }
      }
    );
    assert.equal(schedule.status, 0, schedule.stderr);
    assert.equal(
      schedule.stdout.trim(),
      "200",
      "a recreated container must wait only the remainder of the persisted interval"
    );

    fs.writeFileSync(
      mcPath,
      '#!/bin/sh\n[ "$1" != "--json" ] || shift\ncase "$1" in\n  ls)\n    [ "${MC_LIST_ERROR-}" != "1" ] || exit 1\n    [ -z "${MC_MANIFEST-}" ] || printf \'{"status":"success"}\\n\'\n    ;;\n  cat)\n    [ -n "${MC_MANIFEST-}" ] || exit 1\n    printf \'%s\\n\' "$MC_MANIFEST"\n    ;;\nesac\n',
      { mode: 0o700 }
    );
    const selectRecoverySlot = (manifest: string, listError = false) =>
      spawnSync(
        "sh",
        [
          "-c",
          '. "$1"; choose_recovery_key; printf "%s\\n" "$database_latest_key"',
          "sh",
          functionsPath
        ],
        {
          encoding: "utf8",
          env: {
            ...validEnvironment,
            MC_MANIFEST: manifest,
            MC_LIST_ERROR: listError ? "1" : "0",
            PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
            backup_id: "safe-test-id"
          }
        }
      );
    const manifestFor = (key: string) =>
      JSON.stringify({ database: { objectKey: `staging/database/${key}` } });
    assert.equal(
      selectRecoverySlot("").stdout.trim(),
      "staging/database/latest-a.dump",
      "a new bucket must start with the first recovery slot"
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failedAttempt = selectRecoverySlot(manifestFor("latest-a.dump"));
      assert.equal(failedAttempt.status, 0, failedAttempt.stderr);
      assert.equal(
        failedAttempt.stdout.trim(),
        "staging/database/latest-b.dump",
        "a failed publication must never make the current manifest's slot writable"
      );
    }
    assert.equal(
      selectRecoverySlot(manifestFor("latest-b.dump")).stdout.trim(),
      "staging/database/latest-a.dump"
    );
    assert.equal(
      selectRecoverySlot(manifestFor("latest.dump")).stdout.trim(),
      "staging/database/latest-a.dump",
      "existing manifests must migrate without overwriting the legacy recovery key"
    );
    assert.equal(selectRecoverySlot('{"database":{}}').status, 1);
    assert.equal(selectRecoverySlot("", true).status, 1);
  }
);
