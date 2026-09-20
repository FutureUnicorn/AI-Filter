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
 * `git clean -ffdx` -- the `-x` includes gitignored files. `.runtime/previews/`
 * is gitignored (it holds generated per-preview credentials), so the default
 * checkout at the start of every job destroyed the one record deploy, cleanup,
 * and sweep all need to find an existing preview before they can replace or
 * remove it. `clean: false` is required on every checkout in this workflow, not
 * just one, since all three jobs read that same state.
 */
test("preview jobs never wipe the gitignored runtime state they depend on", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  const checkoutSteps = [...workflow.matchAll(/uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n {6}- name:|\n {4}\S|$)/gu)];
  assert.ok(checkoutSteps.length >= 3, `expected at least 3 checkout steps, found ${checkoutSteps.length}`);
  for (const [, withBlock] of checkoutSteps) {
    assert.match(withBlock ?? "", /clean: false/u, `every checkout in this workflow must set clean: false:\n${withBlock}`);
  }
});

/**
 * AF-93, finding 2. Deploy and cleanup used to disagree about which PRs get a
 * preview: deploy was unrestricted (any base branch), cleanup only fired for
 * PRs based on develop. A PR based on anywhere else got a preview created and
 * never reclaimed except by the 72-hour TTL sweep. Restricting deploy to the
 * same develop/main bases cleanup already covers also matters now that AF-92
 * runs CI on feature/** PRs too -- without this, every stacked feature PR
 * would try to stand up a full preview stack on the one preview host.
 */
test("preview creation and preview cleanup agree on which PRs are in scope", () => {
  const workflow = read(".github/workflows/preview-environment.yml");
  assert.match(workflow, /pull_requests\[0\]\.base\.ref == 'develop'/u);
  assert.match(workflow, /pull_requests\[0\]\.base\.ref == 'main'/u);
  assert.match(workflow, /pull_request_target:\s*\n\s+branches: \[develop, main\]/u);
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

test("the web server refuses to start without a session secret", () => {
  // REV-003's other half. Documenting SESSION_SECRET is not enough on its own:
  // read at request time, its absence is a 500 per request rather than a
  // failure to boot, and the health check reports healthy throughout. Next.js
  // calls register() once and waits for it before serving, so throwing there
  // is what makes absence a startup failure.
  const instrumentation = read("apps/web/src/instrumentation.ts");
  assert.match(instrumentation, /export function register\(/u, "Next.js only calls a function named register");
  assert.match(instrumentation, /SESSION_SECRET/u);
  assert.match(instrumentation, /throw new Error/u, "it has to throw; logging a warning still serves requests");
});
