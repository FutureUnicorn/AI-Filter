import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePreviewStateDirectory } from "../../scripts/environment/model.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

/** Extracts a top-level workflow job block by name (`deploy:`, `cleanup:`, ...). */
function extractJob(workflow: string, jobName: string): string {
  const block = new RegExp(`^ {2}${jobName}:[\\s\\S]*?(?=\\n {2}\\S)`, "mu").exec(workflow)?.[0];
  assert.ok(block, `expected a ${jobName} job block`);
  return block!;
}

/** Extracts a top-level `on:` trigger block (e.g. `pull_request_target:`) up to the next top-level `on:` key, regardless of key order within it. */
function extractTrigger(workflow: string, triggerName: string): string {
  const block = new RegExp(`^ {2}${triggerName}:\\n([\\s\\S]*?)(?=\\n {2}\\S|\\n\\S)`, "mu").exec(workflow)?.[1];
  assert.ok(block !== undefined, `expected an ${triggerName} trigger block`);
  return block!;
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
 *
 * AF-93 PR #85 review (hemnaath04, REV-004). Anchored to the deploy job's
 * `if:` specifically, not a whole-file substring match: the earlier version
 * matched the same expression text sitting anywhere in the file, including
 * inside a comment, so a refactor that moved (rather than removed) the
 * condition passed silently.
 */
test("preview creation is scoped to develop/main base PRs", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const deployJob = extractJob(workflow, "deploy");
  const ifBlock = /^ {4}if: >-\n([\s\S]*?)(?=\n {4}\S)/mu.exec(deployJob)?.[1];
  assert.ok(ifBlock, "expected the deploy job's if: block");
  assert.match(ifBlock!, /pull_requests\[0\]\.base\.ref == 'develop'/u);
  assert.match(ifBlock!, /pull_requests\[0\]\.base\.ref == 'main'/u);
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
 *
 * AF-93 PR #85 review (hemnaath04, REV-001). The original guard matched
 * `branches:` only when it directly followed `pull_request_target:` on the
 * very next line. YAML mapping key order carries no meaning, so writing
 * `types:` first and `branches:` second (a real, working YAML file)
 * defeated the check entirely while restoring the exact leak this test
 * documents. `extractTrigger` reads the whole `pull_request_target:` block
 * regardless of key order, so `branches:` is caught at any position inside
 * it.
 */
test("preview cleanup runs for every closed PR regardless of base branch", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const trigger = extractTrigger(workflow, "pull_request_target");
  assert.match(trigger, /^ {4}types: \[closed\]$/mu);
  assert.doesNotMatch(
    trigger,
    /^\s*branches:/mu,
    "cleanup must not filter on base branch, at any key position: it can change after the preview was created, " +
      "and preview down already no-ops safely when nothing exists"
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
 *
 * AF-93 PR #85 review (hemnaath04, REV-008): parsing switched from `jq` to
 * `node`, an already-hard dependency of this same job two steps later.
 */
test("deploy verifies the source pull request is still open before creating a preview", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  assert.match(workflow, /id: pr-state/u);
  assert.match(workflow, /api\.github\.com\/repos\/\$\{\{ github\.repository \}\}\/pulls\/\$PR_NUMBER/u);
  assert.match(workflow, /console\.log\(`state=\$\{pr\.state\}`\);/u);
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
  assert.match(workflow, /console\.log\(`base_ref=\$\{pr\.base\.ref\}`\);/u);
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
  const deployJob = extractJob(workflow, "deploy");
  const permissionsBlock = /permissions:\n([\s\S]*?)(?=\n {4}\S)/u.exec(deployJob)?.[1];
  assert.ok(permissionsBlock, "expected a job-level permissions block on deploy");
  assert.match(permissionsBlock!, /contents: read/u);
  assert.match(permissionsBlock!, /pull-requests: read/u);
  assert.match(deployJob, /Authorization: Bearer \$GITHUB_TOKEN/u);
  assert.match(deployJob, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
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
 *
 * AF-93 PR #85 review (hemnaath04, REV-002, blocking). The original version
 * of this test asserted only that the literal string
 * `process.env.PREVIEW_STATE_DIRECTORY` appears somewhere in cli.mjs's
 * source -- satisfied by a reference nothing reads from, which the reviewer
 * demonstrated by reverting the actual behaviour while leaving an unused
 * reference in place. Fixed by asserting the RESOLVED path from
 * `resolvePreviewStateDirectory` (scripts/environment/model.mjs) directly,
 * with a synthetic `source`, the same way derivePreviewEnvironment is
 * tested elsewhere -- no docker, no subprocess, and no way for an unused
 * reference to satisfy it. REV-011 (host-persistent override) is asserted
 * here too, since it's the same env-to-path resolution.
 */
test("preview credential state lives outside every job's checkout", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const topLevelEnvBlock = /^env:[\s\S]*?(?=\njobs:)/mu.exec(workflow)?.[0];
  assert.ok(topLevelEnvBlock, "PREVIEW_STATE_DIRECTORY must be set once at the workflow level, not per job");
  assert.match(
    topLevelEnvBlock!,
    /PREVIEW_STATE_DIRECTORY: \$\{\{ vars\.PREVIEW_STATE_DIRECTORY \|\| format\('\{0\}\/\.\.\/preview-state', github\.workspace\) \}\}/u,
    "must default to a path outside the workspace, and stay overridable to a host-level path (REV-011)"
  );

  const cli = read("scripts/environment/cli.mjs");
  assert.match(
    cli,
    /const runtimeDirectory = resolvePreviewStateDirectory\(repositoryRoot\);/u,
    "runtimeDirectory (which previewDirectory, and therefore every state read/write, derives from) must be " +
      "ASSIGNED from the shared, independently-tested resolver's return value -- a call whose result is discarded " +
      "would satisfy a looser text match while leaving the actual defect (state resolved inline, untested) in place"
  );

  const fakeRepositoryRoot = "/repo";
  const configuredElsewhere = resolvePreviewStateDirectory(fakeRepositoryRoot, {
    PREVIEW_STATE_DIRECTORY: "/var/lib/signal-audit/preview-state"
  });
  assert.equal(
    configuredElsewhere,
    "/var/lib/signal-audit/preview-state",
    "an explicitly configured directory must be used as-is, and must not resolve inside the repository checkout"
  );
  assert.ok(
    !configuredElsewhere.startsWith(fakeRepositoryRoot),
    "a configured state directory must never resolve inside the checkout it protects against"
  );

  const fallback = resolvePreviewStateDirectory(fakeRepositoryRoot, {});
  assert.equal(
    fallback,
    path.join(fakeRepositoryRoot, ".runtime"),
    "with nothing configured (local, manual pnpm preview:* use), the resolver must fall back to the in-repo path"
  );

  const blank = resolvePreviewStateDirectory(fakeRepositoryRoot, { PREVIEW_STATE_DIRECTORY: "   " });
  assert.equal(
    blank,
    path.join(fakeRepositoryRoot, ".runtime"),
    "a blank configured value must be treated the same as unset, not resolved to a nonsense empty-string path"
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
 *
 * AF-93 PR #85 review (hemnaath04, REV-003). `assert.match` is satisfied by
 * the FIRST match, so the original version of the compose-file assertions
 * below passed even with only `web`'s build context redirected and
 * `worker`'s silently reverted to `../..` -- half the preview stack drifting
 * back to the trusted checkout's own source with no test noticing. Each
 * service's `build.context` is now extracted and asserted independently.
 */
test("deploy runs orchestration from a trusted checkout and treats the PR checkout as build input only", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const deployJob = extractJob(workflow, "deploy");

  assert.match(
    deployJob,
    /ref: \$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*?clean: false/u,
    "the checkout that cli.mjs runs from must be the trusted default branch"
  );
  assert.match(
    deployJob,
    /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}\s*\n\s+path: pr-source/u,
    "the untrusted PR revision must be checked out into its own subdirectory, not the job's main workspace"
  );
  assert.match(
    deployJob,
    /DEPLOY_SOURCE_DIRECTORY: \$\{\{ github\.workspace \}\}\/pr-source/u,
    "only the build context should point at the untrusted checkout"
  );
  assert.match(
    deployJob,
    /test "\$\(git -C pr-source rev-parse HEAD\)" = "\$TESTED_SHA"/u,
    "the tested-SHA verification must check pr-source's HEAD now that cli.mjs no longer runs from that checkout"
  );
  // REV-005: a runtime check, against the actual resolved config, that both
  // services' build context is the untrusted checkout -- not just a
  // source-text pattern a partial revert could still satisfy.
  assert.match(
    deployJob,
    /docker compose -f infra\/compose\/runtime\.yml config --format json/u,
    "the deploy job must verify the resolved build context at run time, not just trust the compose file's source text"
  );
  assert.match(deployJob, /for \(const service of \["web", "worker"\]\)/u);

  const compose = read("infra/compose/runtime.yml");
  const expectedContext = /context: \$\{DEPLOY_SOURCE_DIRECTORY:-\.\.\/\.\.\}/u;
  for (const service of ["web", "worker"] as const) {
    const serviceBlock = new RegExp(`^ {2}${service}:\\n([\\s\\S]*?)(?=\\n {2}\\S)`, "mu").exec(compose)?.[1];
    assert.ok(serviceBlock, `expected a ${service} service block`);
    assert.match(
      serviceBlock!,
      expectedContext,
      `${service}'s build context must resolve to the untrusted checkout, independently of the other service`
    );
  }
  assert.match(compose, /\$\{DEPLOY_SOURCE_DIRECTORY:-\.\.\/\.\.\}\/packages\/db\/migrations:\/migrations:ro/u);
  assert.match(compose, /\$\{DEPLOY_SOURCE_DIRECTORY:-\.\.\/\.\.\}\/tests\/fixtures\/environment:\/fixtures:ro/u);
});

/**
 * AF-93 PR #85 review (hemnaath04, REV-007). pr-source holds the untrusted
 * PR's own source tree and is never executed, but nothing removed it either
 * -- left in place it would persist in the trusted workspace indefinitely,
 * surviving until (if ever) a future deploy run happens to reuse this exact
 * path. Removed unconditionally so untrusted code does not have an
 * unbounded lifetime on a shared, reused host.
 */
test("the untrusted build-context checkout is removed after every deploy attempt", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const deployJob = extractJob(workflow, "deploy");
  assert.match(deployJob, /if: always\(\)\s*\n\s+run: rm -rf pr-source/u);
});

/**
 * AF-93 PR #85 review (hemnaath04, REV-009). Found only in the review's
 * summary body, not delivered as an inline comment, but real: the live
 * pr-state check used to run AFTER both checkouts, so a PR that was already
 * closed or retargeted still paid for checking out both revisions -- and
 * placed the untrusted PR tree on the runner -- before declining. pr-state
 * needs neither checkout (a plain API call), so it now runs first, and both
 * checkouts are gated on its result the same way the build-context
 * verification and deploy steps already were. A declined run also writes to
 * $GITHUB_STEP_SUMMARY, so the reason is visible without reading the `if:`.
 *
 * The job-level `environment:` block still registers a GitHub deployment
 * the moment the job starts, before any step (including this one) can run
 * -- reordering steps cannot reach that; closing it fully would need
 * splitting this into a separate, environment-free check job ahead of a
 * deploy job, out of scope for this fix and noted as such in the workflow.
 */
test("the live PR-state check runs before either checkout, and both checkouts are gated on it", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const deployJob = extractJob(workflow, "deploy");

  const prStateIndex = deployJob.indexOf("id: pr-state");
  const firstCheckoutIndex = deployJob.indexOf("uses: actions/checkout");
  assert.ok(prStateIndex >= 0 && firstCheckoutIndex >= 0, "expected both the pr-state step and a checkout step");
  assert.ok(prStateIndex < firstCheckoutIndex, "the live PR-state check must run before any checkout");

  const checkoutSteps = [...deployJob.matchAll(/- name: Check out[^\n]*\n([\s\S]*?)(?=\n {6}- name:|\n {4}\S|$)/gu)];
  assert.equal(checkoutSteps.length, 2, "expected exactly two checkout steps in the deploy job");
  for (const [, withBlock] of checkoutSteps) {
    assert.match(
      withBlock ?? "",
      /steps\.pr-state\.outputs\.state == 'open'/u,
      "every checkout must be gated on the same live check, not run unconditionally before it's known whether to deploy"
    );
  }

  assert.match(deployJob, /name: Report a declined deploy/u);
  assert.match(deployJob, /GITHUB_STEP_SUMMARY/u);
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
