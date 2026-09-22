import assert from "node:assert/strict";
import fs from "node:fs";
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
  assert.match(cli, /runDocker\(environment\.project, environment\.variables, \["up", "-d", "postgres", "storage"\], local\);/u);
  assert.match(cli, /runDocker\(environment\.project, environment\.variables, \["up", "-d", "--build", "web", "worker"\]\);/u);
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
  const backupEnvironment = /x-backup-environment:[\s\S]*?(?=\nservices:)/u.exec(compose)?.[0];
  const webService = /^ {2}web:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  const workerService = /^ {2}worker:[\s\S]*?(?=\n {2}\S)/mu.exec(compose)?.[0];
  assert.ok(backupService);
  assert.ok(backupEnvironment);
  assert.ok(webService);
  assert.ok(workerService);

  assert.match(backupService!, /profiles: \[backups\]/u);
  assert.match(backupService!, /networks: \[public, private\]/u);
  assert.match(backupService!, /read_only: true/u);
  assert.match(backupService!, /cap_drop: \["ALL"\]/u);
  assert.match(backupService!, /no-new-privileges:true/u);
  assert.match(backupService!, /signal-audit-backup", "health/u);
  assert.match(backupEnvironment!, /BACKUP_CONTROL_OWNER:/u);
  assert.match(backupEnvironment!, /BACKUP_ENCRYPTION_REFERENCE:/u);
  assert.doesNotMatch(webService!, /BACKUP_ACCESS_KEY_ID|BACKUP_SECRET_ACCESS_KEY/u);
  assert.doesNotMatch(workerService!, /BACKUP_ACCESS_KEY_ID|BACKUP_SECRET_ACCESS_KEY/u);

  const script = read("scripts/backups/backup.sh");
  assert.match(script, /BACKUP_ENDPOINT must use https/u);
  assert.match(script, /--enc-s3/u);
  assert.match(script, /mc --quiet mirror[\s\S]*?--overwrite[\s\S]*?--remove/u);
  assert.equal((script.match(/mirror_storage "\$backup_id"/gu) ?? []).length, 2);
  assert.match(script, /pg_dump[\s\S]*?--format=custom/u);
  assert.match(script, /pg_restore --list/u);
  assert.match(script, /sha256sum/u);
  assert.match(script, /last-success-epoch/u);
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
  assert.match(script, /af68-database-retention/u);
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

  for (const ruleId of ["af68-database-retention", "af68-manifest-history-retention"]) {
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
    assert.match(workflow, /BACKUP_ACCESS_KEY_ID: \$\{\{ secrets\.BACKUP_ACCESS_KEY_ID \}\}/u);
    assert.match(workflow, /BACKUP_SECRET_ACCESS_KEY: \$\{\{ secrets\.BACKUP_SECRET_ACCESS_KEY \}\}/u);
    assert.doesNotMatch(workflow, /BACKUP_SECRET_ACCESS_KEY: \$\{\{ vars\./u);
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
});
