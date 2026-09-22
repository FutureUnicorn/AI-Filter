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

/**
 * AF-93, finding 1. `actions/checkout` defaults to `clean: true`, which runs
 * `git clean -ffdx` -- the `-x` includes gitignored files. Preview credential
 * state used to be gitignored inside each checkout, so the default checkout
 * at the start of every job destroyed the one record deploy, cleanup, and
 * sweep all needed to find an existing preview before they could replace or
 * remove it. `clean: false` is required on every checkout that runs
 * orchestration code (cli.mjs) from -- deploy's trusted default-branch
 * checkout, and cleanup's and sweep's.
 *
 * The one exception is deploy's SECOND checkout, `pr-source` (the untrusted
 * PR revision, added in a later review round): it is never executed and
 * carries no state of its own, only Docker build input that is meant to be
 * exactly the tested SHA's tree on every run -- so `clean: true` there is
 * correct, not an oversight.
 */
test("preview jobs never wipe the gitignored runtime state they depend on", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const checkoutSteps = [...workflow.matchAll(/uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n {6}- name:|\n {4}\S|$)/gu)];
  assert.ok(checkoutSteps.length >= 4, `expected at least 4 checkout steps, found ${checkoutSteps.length}`);
  const orchestrationCheckouts = checkoutSteps.filter(([, withBlock]) => !(withBlock ?? "").includes("path: pr-source"));
  assert.ok(orchestrationCheckouts.length >= 3, "expected at least 3 checkouts that orchestration code runs from");
  for (const [, withBlock] of orchestrationCheckouts) {
    assert.match(
      withBlock ?? "",
      /clean: false/u,
      `every checkout that orchestration code runs from must set clean: false:\n${withBlock}`
    );
  }
});

/**
 * AF-93, finding 2. Deploy and cleanup used to disagree about which PRs get a
 * preview: deploy was unrestricted (any base branch), cleanup only fired for
 * PRs based on develop. A PR based on anywhere else got a preview created and
 * never reclaimed except by the 72-hour TTL sweep. Restricting deploy scope
 * also matters now that AF-92 runs CI on feature/** PRs too -- without this,
 * every stacked feature PR would try to stand up a full preview stack on the
 * one preview host.
 */
test("preview creation is scoped to develop/main base PRs", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  assert.match(workflow, /pull_requests\[0\]\.base\.ref == 'develop'/u);
  assert.match(workflow, /pull_requests\[0\]\.base\.ref == 'main'/u);
});

/**
 * AF-93 PR #85 review (Copilot). The first cut of this fix narrowed the
 * cleanup trigger to `branches: [develop, main]` to match deploy -- but
 * cleanup filters on the PR's CURRENT base branch at close time, which can
 * change after the preview was created (GitHub allows retargeting a PR's
 * base without closing it). A preview created while based on develop, then
 * retargeted elsewhere before closing, would never be cleaned up except by
 * the 72-hour sweep. `preview down` already no-ops when no state exists
 * (scripts/environment/cli.mjs downPreview), so cleanup is safe to run
 * unconditionally for every closed PR rather than gating on a mutable
 * property -- unlike creation, which must stay scoped to bound how many
 * preview stacks run on the one host at once.
 */
test("preview cleanup runs for every closed PR regardless of base branch", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  assert.match(workflow, /pull_request_target:\s*\n\s+types: \[closed\]/u);
  assert.doesNotMatch(
    workflow,
    /pull_request_target:\s*\n\s+branches:/u,
    "cleanup must not filter on base branch: it can change after the preview was created, and preview down " +
      "already no-ops safely when nothing exists"
  );
});

/**
 * AF-93 PR #85 review (Copilot). `workflow_run` fires on CI completion, which
 * can happen after the source PR has already closed -- the event's
 * pull_requests[0] entry is a snapshot from when CI was triggered and does
 * not reflect that. Without a live check, a CI run that started before close
 * and finished after it could still pass the deploy job's `if` condition and
 * recreate an environment for a PR that close-triggered cleanup already
 * (correctly) tore down, with no later cleanup event to catch it.
 */
test("deploy verifies the source pull request is still open before creating a preview", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  assert.match(workflow, /id: pr-state/u);
  assert.match(workflow, /api\.github\.com\/repos\/\$\{\{ github\.repository \}\}\/pulls\/\$PR_NUMBER/u);
  assert.match(workflow, /echo "state=\$\(jq -r '\.state' <<< "\$response"\)" >> "\$GITHUB_OUTPUT"/u);
  assert.match(workflow, /if: >-\s*\n\s+steps\.pr-state\.outputs\.state == 'open'/u);
});

/**
 * AF-93 PR #85 review (Copilot), "previously missed" finding surfaced once
 * the checkout split above landed. The deploy job's `if:` gate only sees
 * workflow_run.pull_requests[0].base.ref, a snapshot from when CI was
 * TRIGGERED -- if the PR is retargeted away from develop/main while that CI
 * run is still in flight, the snapshot still reads develop/main and the job
 * still starts. The live check already re-reads open/closed from the API
 * for the same reason (a late-completing run can't trust the snapshot); it
 * must re-read base.ref from that same response too, or retargeting during
 * the run is a live gap the closing-during-the-run case right next to it no
 * longer has.
 */
test("deploy re-validates the current base branch, not just the workflow_run snapshot", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  assert.match(workflow, /echo "base_ref=\$\(jq -r '\.base\.ref' <<< "\$response"\)" >> "\$GITHUB_OUTPUT"/u);
  assert.match(
    workflow,
    /steps\.pr-state\.outputs\.base_ref == 'develop' \|\| steps\.pr-state\.outputs\.base_ref == 'main'/u
  );
});

/**
 * AF-93 PR #85 review (Copilot). The live PR-state check calls the GitHub
 * API; without an Authorization header it works only for a public repository
 * and is subject to the unauthenticated rate limit, so an eligible preview
 * deployment could fail closed once that limit is exhausted (or always, for
 * a private repository). The deploy job needs its own pull-requests: read
 * grant because job-level permissions replace, not merge with, the
 * workflow-level contents: read block.
 */
test("the live pull-request-state check is authenticated", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const deployJob = /^ {2}deploy:[\s\S]*?(?=\n {2}\S)/mu.exec(workflow)?.[0];
  assert.ok(deployJob, "expected a deploy job block");
  const permissionsBlock = /permissions:\n([\s\S]*?)(?=\n {4}\S)/u.exec(deployJob!)?.[1];
  assert.ok(permissionsBlock, "expected a job-level permissions block on deploy");
  assert.match(permissionsBlock!, /contents: read/u);
  assert.match(permissionsBlock!, /pull-requests: read/u);
  assert.match(deployJob!, /Authorization: Bearer \$GITHUB_TOKEN/u);
  assert.match(deployJob!, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
});

/**
 * AF-93 PR #85 review (Copilot), high severity. The deploy job's checkout of
 * the PR's own untrusted head SHA must keep clean: false (finding 1), which
 * means anything left inside that checkout survives into it. Preview state
 * used to live at repositoryRoot/.runtime, i.e. INSIDE the git working tree
 * that checkout populates -- so the untrusted checkout gained read access to
 * every other preview's already-generated database and storage credentials
 * the moment cli.mjs ran, and .gitignore itself documented exactly where to
 * find them. PREVIEW_STATE_DIRECTORY must be set at the workflow level (so
 * deploy, cleanup, and sweep all agree on one location) and must not resolve
 * inside the checkout.
 */
test("preview credential state lives outside every job's checkout", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const topLevelEnvBlock = /^env:[\s\S]*?(?=\njobs:)/mu.exec(workflow)?.[0];
  assert.ok(topLevelEnvBlock, "PREVIEW_STATE_DIRECTORY must be set once at the workflow level, not per job");
  assert.match(topLevelEnvBlock!, /PREVIEW_STATE_DIRECTORY: \$\{\{ github\.workspace \}\}\/\.\.\/preview-state/u);

  const cli = read("scripts/environment/cli.mjs");
  assert.match(
    cli,
    /process\.env\.PREVIEW_STATE_DIRECTORY/u,
    "cli.mjs must read the runner-provided state location rather than always deriving one inside the checkout"
  );
});

/**
 * AF-93 PR #85 review (Copilot), high severity follow-up. Moving credential
 * state outside the checkout (previous test) stops the untrusted checkout
 * from stumbling onto OTHER previews' secrets via .gitignore, but the deploy
 * job still ran cli.mjs itself FROM that same untrusted checkout -- so a
 * modified cli.mjs could simply read process.env.PREVIEW_STATE_DIRECTORY and
 * exfiltrate every pr-*.json it finds, or run arbitrary commands as the
 * runner user. cli.mjs and this workflow now run from a TRUSTED
 * default-branch checkout; the untrusted PR's own revision is checked out
 * separately into pr-source and used ONLY as the Docker build context
 * (infra/compose/runtime.yml's web/worker build.context and the migrate/seed
 * bind mounts, via DEPLOY_SOURCE_DIRECTORY) -- never executed as a script.
 */
test("deploy runs orchestration from a trusted checkout and treats the PR checkout as build input only", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const deployJob = /^ {2}deploy:[\s\S]*?(?=\n {2}\S)/mu.exec(workflow)?.[0];
  assert.ok(deployJob, "expected a deploy job block");

  assert.match(
    deployJob!,
    /ref: \$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*?clean: false/u,
    "the checkout that cli.mjs runs from must be the trusted default branch"
  );
  assert.match(
    deployJob!,
    /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}\s*\n\s+path: pr-source/u,
    "the untrusted PR revision must be checked out into its own subdirectory, not the job's main workspace"
  );
  assert.match(
    deployJob!,
    /DEPLOY_SOURCE_DIRECTORY: \$\{\{ github\.workspace \}\}\/pr-source/u,
    "only the build context should point at the untrusted checkout"
  );
  assert.match(
    deployJob!,
    /test "\$\(git -C pr-source rev-parse HEAD\)" = "\$TESTED_SHA"/u,
    "the tested-SHA verification must check pr-source's HEAD now that cli.mjs no longer runs from that checkout"
  );

  const compose = read("infra/compose/runtime.yml");
  assert.match(compose, /context: \$\{DEPLOY_SOURCE_DIRECTORY:-\.\.\/\.\.\}/u);
  assert.match(compose, /\$\{DEPLOY_SOURCE_DIRECTORY:-\.\.\/\.\.\}\/packages\/db\/migrations:\/migrations:ro/u);
  assert.match(compose, /\$\{DEPLOY_SOURCE_DIRECTORY:-\.\.\/\.\.\}\/tests\/fixtures\/environment:\/fixtures:ro/u);
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
