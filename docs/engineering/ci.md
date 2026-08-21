# Continuous integration and release gates

## Purpose

AF-12 makes repository validation fail closed. A revision is merge-eligible only
after lint, type-checking, unit tests, integration tests, architecture checks,
and the real workspace build have succeeded. Production eligibility is tied to
the exact successful `main` revision.

The workflows do not provision or deploy an environment. AF-11 owns development,
preview, staging, and production infrastructure and must connect any future
production deployment behind the gate described below.

## When CI runs

`.github/workflows/ci.yml` runs for:

- pull requests targeting `develop` or `main`;
- pushes to `develop` or `main`;
- merge-queue validation through the `merge_group` event.

Superseded runs for the same pull request or ref are cancelled. Validation has
read-only repository permission and does not receive production secrets.

## Required jobs and local equivalents

| Remote check | Local command | Coverage |
|---|---|---|
| `CI / Lint` | `pnpm lint` | Applications, packages, tests, and configuration |
| `CI / Typecheck` | `pnpm typecheck` | Web, worker, and every TypeScript package |
| `CI / Unit` | `pnpm test:unit` | Deterministic citation-validation unit tests |
| `CI / Integration` | `pnpm test:integration` | Worker-to-domain workspace integration |
| `CI / Architecture` | `pnpm check:architecture` | Dependency direction, workspace structure, and CI policy |
| `CI / Build` | `pnpm build` | Next.js production build, worker, and buildable packages |
| `CI / Required` | `pnpm check` | Fail-closed aggregate of all required categories |

From a clean checkout, use the pinned toolchains and lockfiles:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Python dependencies are resolved by `uv run --locked`; Node dependencies are
installed by pnpm with `--frozen-lockfile`. `.nvmrc`, `packageManager` in
`package.json`, `[tool.uv].required-version`, `pnpm-lock.yaml`, and `uv.lock`
make runtime and dependency changes reviewable.

The current integration boundary has no database dependency, so CI does not
start an unused service. When an integration test genuinely requires Postgres
or another service, add a disposable, per-run service with synthetic data. It
must never connect to staging, production, or real applicant information.

## Aggregate merge gate

`CI / Required` always evaluates all upstream job results and succeeds only when
every required result is `success`. Cancelled, skipped, timed-out, and failed
dependencies therefore make the aggregate check fail.

Configure GitHub rules for both `develop` and `main`:

1. Require a pull request before merging.
2. Require the `CI / Required` status check.
3. Require the branch to be current with its base, or use the merge queue.
4. Block merging while the required check is pending or failing.
5. Restrict bypass actors and block force pushes and deletion.

The status must first be reported by a real workflow run before it can be
selected reliably in repository settings. Renaming the aggregate job requires
updating the rules in the same reviewed change.

Workflow YAML cannot activate GitHub branch protection by itself. AF-12 remote
validation is incomplete until repository settings show the required status and
a deliberately failing pull request is visibly unmergeable.

## Production eligibility

`.github/workflows/production-gate.yml` has no manual trigger. It responds only
to completion of the `CI` workflow on `main`, and its eligibility job runs only
when all of the following are true:

- the CI conclusion is `success`;
- the source event was a protected-branch `push`;
- the tested branch is `main`;
- the checked-out SHA equals `workflow_run.head_sha`.

A failed or pending CI run cannot start an eligibility job. The workflow has
read-only contents permission, no environment, and no production secrets.

When AF-11 implements deployment, its production job must:

1. live downstream of the `eligibility` job;
2. deploy `github.event.workflow_run.head_sha`, or an immutable artifact built
   from that exact SHA;
3. use a protected `production` environment with environment-scoped secrets;
4. expose no deployment credentials to pull-request jobs;
5. provide no independent `workflow_dispatch` path that accepts an arbitrary SHA.

Adding another production workflow or hosting integration that bypasses this
path violates AF-12.

## Failure validation

Use temporary, uncommitted changes to prove each local command fails closed:

- unused variable for lint;
- incompatible assignment for type-checking;
- incorrect unit assertion;
- incorrect integration expectation;
- forbidden domain-to-adapter import for architecture;
- unresolved production import for build;
- manifest/lockfile mismatch for frozen installation.

Remove every deliberate failure and rerun `pnpm check`. On the AF-12 pull
request, retain remote evidence that a red `CI / Required` status blocks merge,
then push the fixes and retain the final green run.

## Extending required CI

Add future deterministic suites as independent jobs, include their job IDs in
the `ci-required.needs` list, add their result to the fail-closed assertion, and
update the CI policy test and this document. Live AI evaluations, production
services, arbitrary internet data, retries that hide flakiness, and real PII do
not belong in the required pull-request pipeline.
