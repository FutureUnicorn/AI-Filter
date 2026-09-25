# Environment architecture and operations

## Scope and policy

AF-11 establishes isolated development, preview, staging, and production-shaped
validation environments. The exception recorded in
[`../PRODUCT_BOUNDARY.md`](../PRODUCT_BOUNDARY.md#af-11-synthetic-infrastructure-validation-exception)
allows infrastructure validation before the paid-pilot gate, but it does not
authorize a hosted product.

All AF-11 environments are synthetic-only. They must not contain applicant or
employer data, serve customers, enable authentication, or operate a hiring
workflow. The environment called `production` is empty validation
infrastructure until the product evidence gate passes.

## Environment matrix

| Concern | Development | Preview | Staging | Production-shaped validation |
|---|---|---|---|---|
| Lifecycle | developer controlled | PR/SHA scoped and disposable | persistent | persistent, controlled |
| Database | local Postgres | unique Postgres instance and schema | staging-only instance | production-only instance |
| Storage | local MinIO bucket | unique MinIO instance and bucket | staging-only bucket | production-only private bucket |
| Data | synthetic | synthetic | synthetic | empty; no fixture seeding |
| Credentials | documented local-only values | generated per deployment | GitHub staging secrets | GitHub production secrets |
| Runtime | host web/worker or Compose | same Docker build path | same Docker build path | same Docker build path |
| Cost control | local machine | CPU/memory ceilings + TTL | ceilings + provider budget reference | ceilings + provider budget/cap reference |
| Administration | developer | preview deployment runner | named staging role | protected environment + named role + provider audit reference |
| Backups | disabled | disabled; disposable | off-host when approved | off-host when approved |
| Deploy source | working tree | exact PR SHA after green CI | exact green `develop` SHA | exact green `main` SHA |

`NODE_ENV` does not identify these environments. `APP_ENV` must be one of
`development`, `test`, `preview`, `staging`, or `production`.

## Local development

Prerequisites:

- Node.js 24 and Corepack;
- Python 3.13 and `uv` for the existing tests;
- Docker Engine or Docker Desktop with Compose v2.

Copy `.env.example` to `.env.local`. The example contains intentionally local
credentials only; never replace its values with staging or production secrets.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev:infra
pnpm db:seed
pnpm env:smoke
pnpm dev:web
pnpm dev:worker
```

Local endpoints:

- PostgreSQL: `127.0.0.1:5432`
- MinIO S3 API: `http://127.0.0.1:9000`
- MinIO console: `http://127.0.0.1:9001`
- web: `http://127.0.0.1:3000`
- worker health: `http://127.0.0.1:3001/health/environment`

The web environment health endpoint is
`http://127.0.0.1:3000/health/environment`. It checks authenticated database
and storage connectivity without returning credentials.

Reset local state deterministically:

```bash
pnpm dev:reset
pnpm env:smoke
```

`dev:reset` removes only the explicitly named
`signal-audit-development` Compose project and refuses staging or production
targets. The seed has an additional in-container production guard. Its one
record and object are visibly synthetic and use the reserved `example.test`
domain.

## Preview lifecycle

Preview deployment is triggered by a completed successful `CI` workflow for a
same-repository pull request based on `develop` or `main`. The workflow checks
out `workflow_run.head_sha`, verifies the checked-out SHA, and deploys through
a runner labelled `signal-audit-preview`.

AF-93: deploy is scoped this way so an unbounded number of stacked PRs cannot
each try to stand up a full preview stack on the one preview host. Cleanup is
deliberately NOT scoped the same way -- it runs for every closed PR regardless
of base branch, since a PR's base can be retargeted after its preview was
created, and `preview down` already no-ops safely when there is nothing to
remove. Gating cleanup on a mutable property is what created the leak in the
first place. Deploy also verifies the source pull request is still open
(a live API check, not the `workflow_run` event's snapshot) immediately before
calling `preview up`, since a CI run that started before the PR closed can
complete after it, which the event payload alone cannot distinguish.

Every checkout that orchestration code runs FROM (deploy's trusted
default-branch checkout, and cleanup's and sweep's) also sets `clean: false`
-- `actions/checkout` defaults to wiping every gitignored file, and the
preview state directory (the record of which previews exist) is gitignored,
so the default checkout destroyed that record before each job could read it.
The one exception is deploy's second checkout, `pr-source` (the untrusted PR
revision, see below): it is never executed and carries no state of its own
between runs, only Docker build input that should be exactly the tested
SHA's tree every time, so it deliberately keeps the default `clean: true`.

Preview state -- one JSON file per PR carrying its generated database and
storage credentials -- lives at `PREVIEW_STATE_DIRECTORY`
(`scripts/environment/cli.mjs`), a fixed, runner-persistent path OUTSIDE
every job's git checkout, set once at the workflow level so deploy, cleanup,
and sweep all agree on it. Falling back to an in-repo `.runtime/` when the
variable is unset keeps local, manual `pnpm preview:*` usage on a
developer's own machine unchanged.

This state root moved with this change (from inside the checkout to
`PREVIEW_STATE_DIRECTORY`). Since this workflow has never fired -- confirmed
via the GitHub Actions API, which returns no recorded runs, consistent with
these files existing only on `develop` and not yet on the default branch --
there should be nothing at the old in-workspace path to strand. If that
changes before this promotes, confirm on the runner that the old
`<workspace>/.runtime/previews` is empty and `docker compose ls` shows no
`signal-audit-pr-` projects before relying on the new path; see "Preview
leak" under Troubleshooting below for locating a project by that prefix.

That alone is not enough, and the deploy job is structured around the
reason: `scripts/environment/cli.mjs` -- the orchestration script that reads
`PREVIEW_STATE_DIRECTORY` and shells out to Docker -- must never itself be
code the PR under test controls. Running it from the PR's own checkout would
let a modified `cli.mjs` read that variable directly and exfiltrate every
OTHER preview's credentials (or run arbitrary commands as the runner user),
regardless of where the credential files live. So deploy checks out TWO
revisions: the default branch (trusted, where `cli.mjs` and this workflow's
own commands run from) into the job's main workspace, and the PR's own
tested SHA into a `pr-source` subdirectory that is never executed directly
-- only consumed as `DEPLOY_SOURCE_DIRECTORY`, the Docker build context for
`infra/compose/runtime.yml`'s `web`/`worker` services, and the mount source
for the `migrate`/`seed` bind mounts (which must still run that PR's own
migrations for correctness). Every other caller of that compose file --
local development, staging, production, manual `pnpm preview:*` -- leaves
`DEPLOY_SOURCE_DIRECTORY` unset and gets the previous, single-checkout
behavior unchanged.

This closes the orchestration-script attack surface Copilot's review
identified. It does not, on its own, sandbox the `docker build` step itself
-- a PR's own Dockerfile still executes build instructions on the shared
runner host during that build. That is the open question of untrusted code
executing on a persistent, reused self-hosted runner, tracked separately,
and needs the same kind of infrastructure decision (ephemeral build
runners, or tighter Docker daemon sandboxing) to close fully.

One consequence worth stating plainly (PR #85 review, hemnaath04, REV-005):
because `cli.mjs` resolves `infra/compose/runtime.yml` from its own
(trusted, default-branch) checkout, a preview always runs the DEFAULT
BRANCH's compose topology -- service definitions, resource limits, network
and security settings -- never the PR's own edits to that file. Only the
Dockerfile (via `DEPLOY_SOURCE_DIRECTORY`, itself relative to whatever the
compose file's `build.context` says), migrations, and fixtures come from
the PR. This is deliberate, not an oversight: letting an untrusted PR
control the compose file directly (volumes, `security_opt`, network mode)
would reopen the exact credential-exposure and arbitrary-execution risk the
checkout split exists to close. The practical implication is that a PR
which edits the compose file -- for example adding an environment variable
a service needs -- gets a preview that does not reflect that edit, in a way
that will not reproduce locally. The deploy job verifies (via
`docker compose config`, against the actual resolved configuration rather
than the compose file's source text) that both `web` and `worker`
`build.context` resolve to the untrusted checkout before deploying, so a
regression here fails the job loudly instead of silently building the wrong
revision.

Each preview receives:

- project: `signal-audit-pr-<PR>-<SHA>`;
- database schema: `pr_<PR>_<SHA>` inside its own disposable Postgres instance;
- bucket: `signal-audit-preview-pr-<PR>-<SHA>` inside its own disposable MinIO instance;
- randomly generated database and storage credentials;
- a state file under `PREVIEW_STATE_DIRECTORY` (or ignored `.runtime/previews/`
  locally) with mode `0600` where the operating system supports POSIX
  permissions;
- a deployment URL associated with GitHub's PR-specific environment.

Manual validation commands are:

```bash
pnpm preview:up -- --pr 123 --sha <commit-sha>
pnpm preview:down -- --pr 123
pnpm preview:sweep -- --ttl-hours 72
```

Updating a PR destroys the previous SHA-scoped project before creating the new
one. Closing the PR runs trusted cleanup code from the default branch. A daily
TTL sweep provides backup cleanup. All teardown operations are idempotent.

Two-preview isolation is proved by deploying two PR numbers, seeding different
synthetic markers, checking their separate health endpoints, and verifying the
derived database, bucket, project, and credentials differ. Never perform this
test with production data.

## Staging

Staging deploys only after successful CI for a `develop` push. It uses the same
Dockerfile, Postgres major version, S3 API, migration command, web process,
worker process, health checks, and secret injection pattern as production.
Intentional differences are lower resource limits, synthetic fixtures, staging
credentials, and staging URLs.

Configure a GitHub environment named `staging`, a self-hosted runner labelled
`signal-audit-staging`, and the variables/secrets listed below. The runner host
must expose the web container through the URL in `STAGING_URL` and must retain
the `signal-audit-staging` Compose volumes. When AF-68 backups are enabled, the
runner must also allow encrypted egress to the approved off-host S3-compatible
backup endpoint.

## Production-shaped validation

Production deployment has no manual workflow trigger. It is downstream of
AF-12's successful `main` CI workflow and `Production / Eligible` exact-SHA
check. The deploy job requires that eligibility job and checks the SHA again.

The `production` GitHub environment must:

- require a named approving reviewer who is not the deployer;
- allow deployment only from `main`;
- contain credentials not used by staging or preview;
- expose only the empty validation environment;
- keep `PRODUCTION_VALIDATION_ONLY=true`;
- record deployment approvals and runs in GitHub; and
- link to the hosting provider's audit log for host/console administration.

Production does not run the synthetic seed command. Reset, seed, and destructive
local commands reject `APP_ENV=production`.

## GitHub environment configuration

Set repository variable `AF11_ENABLE_HOSTED_ENVIRONMENTS=true` only after all
three environments and runners are configured. Until then hosted jobs fail
closed or remain disabled.

Preview variables:

| Name | Purpose |
|---|---|
| `AF11_ENABLE_HOSTED_ENVIRONMENTS` | explicit deployment enablement |
| `PREVIEW_BASE_DOMAIN` | wildcard preview DNS suffix |
| `PREVIEW_TTL_HOURS` | orphan lifetime, normally `72` |
| `PREVIEW_STATE_DIRECTORY` | optional; overrides the default per-runner-workspace preview state path. Set this to a host-level absolute path (for example `/var/lib/signal-audit/preview-state`) if the `signal-audit-preview` runner label ever backs more than one runner process on the same host -- otherwise each process gets an independent, empty state directory and cleanup dispatched to the wrong one silently finds nothing to remove (PR #85 review, REV-011). |

Staging and production environment secrets:

| Name | Requirement |
|---|---|
| `POSTGRES_USER` | environment-only service identity |
| `POSTGRES_PASSWORD` | environment-only secret, at least 20 characters |
| `STORAGE_ACCESS_KEY_ID` | environment-only storage identity |
| `STORAGE_SECRET_ACCESS_KEY` | environment-only secret, at least 20 characters |
| `BACKUP_ADMIN_ACCESS_KEY_ID` | short-lived deploy identity for bucket creation, privacy, versioning, and lifecycle controls |
| `BACKUP_ADMIN_SECRET_ACCESS_KEY` | admin secret, at least 20 characters; supplied only to one-shot `backup-init` |
| `BACKUP_WRITER_ACCESS_KEY_ID` | long-running identity limited to encrypted object read/write/list and ordinary delete markers |
| `BACKUP_WRITER_SECRET_ACCESS_KEY` | writer secret, at least 20 characters; explicitly denied bucket administration and version deletion |

Staging and production environment variables:

| Name | Requirement |
|---|---|
| `AF11_ENABLE_HOSTED_ENVIRONMENTS` | `true` after controls are verified |
| `COST_CONTROL_REFERENCE` | provider budget, cap, quota, or alert identifier/URL |
| `COST_CONTROL_OWNER` | named accountable person/team |
| `ADMIN_AUDIT_REFERENCE` | provider audit-log identifier/URL |
| `ADMIN_ROLE_ALLOWLIST` | named role/group, never a shared account |
| `STAGING_URL` / `PRODUCTION_URL` | private validation endpoint |
| `BACKUP_ENABLED` | `true` only after AF-68 controls and values are approved; otherwise `false` |
| `BACKUP_ENDPOINT` / `BACKUP_REGION` / `BACKUP_BUCKET` | HTTPS off-host destination and dedicated bucket |
| `BACKUP_INTERVAL_SECONDS` | team-approved recovery-point interval; no repository default |
| `BACKUP_RETENTION_DAYS` | team-approved retention window; no repository default |
| `BACKUP_PATH_STYLE` | provider-compatible `auto`, `on`, or `off` |
| `BACKUP_CONTROL_OWNER` | accountable person/team |
| `BACKUP_ENCRYPTION_REFERENCE` | provider SSE-S3/KMS control evidence, never key material |

The backup destination must be a different failure domain from the Compose
host and its PostgreSQL/MinIO volumes. See
[`../operations/backups.md`](../operations/backups.md) for the backup set,
retention rules, privacy boundary, health signal, and AF-69 restore handoff.

Do not copy values between environments. Secret values must never appear in Git,
Jira, screenshots, workflow output, or shell history.

## Spend controls

The repository supplies defense in depth through per-service CPU/memory limits,
no autoscaling, isolated preview projects, immediate PR-close cleanup, and a
72-hour orphan sweep. The selected infrastructure provider must additionally
configure and record a real billing alert, quota, or hard cap.

| Cost source | Preview | Staging | Production validation | Owner/evidence |
|---|---|---|---|---|
| compute | fixed Compose ceilings + cleanup | fixed ceilings | fixed ceilings | `COST_CONTROL_REFERENCE` |
| database | disposable volume | fixed local volume | fixed local volume | provider billing reference |
| storage | disposable volume | fixed local volume | fixed local volume | provider billing reference |
| AI provider | disabled | disabled | disabled | no key is injected by AF-11 |

Hosted deployment must remain disabled when the cost-control reference or owner
is absent.

## Administrative access and auditability

Normal developers do not need production access. Production administration is
limited to the role in `ADMIN_ROLE_ALLOWLIST`; use individual identities and MFA
where the hosting provider supports it. GitHub records environment approvals and
deployments. Host, database-console, storage-policy, credential, and billing
changes must also be attributable through the provider audit log referenced by
`ADMIN_AUDIT_REFERENCE`.

Before AF-11 is closed, perform one safe configuration read/change and retain
evidence showing named actor, timestamp, action, and resource. Never include a
secret value. If the selected provider cannot produce this evidence, it does not
satisfy AF-11.

## Validation and evidence checklist

1. Start from a fresh checkout and run local startup, seed, and smoke commands.
2. Run `pnpm dev:reset` and repeat the smoke check.
3. Prove production reset and seed attempts return non-zero without touching a
   production resource.
4. Deploy two preview PRs and prove their project, schema, bucket, credentials,
   and data differ.
5. Close one PR and capture successful teardown; run the TTL sweep safely.
6. Deploy staging from the exact green `develop` SHA and capture web/worker
   health results.
7. Compare staging and production resource identifiers—not values—and prove
   non-production credentials are denied against the production boundary.
8. Record the spend control, owner, named administrator role, MFA state, and one
   provider audit event.
9. Deploy the empty production-shaped environment from the exact green `main`
   SHA through `Production / Eligible`.

Do not mark AF-11 Done if any external provider evidence in steps 4-9 is absent.

## Troubleshooting and cleanup

- Docker unavailable: start Docker Engine/Desktop and rerun `docker version`.
- Port conflict: set local `POSTGRES_HOST_PORT`, `STORAGE_HOST_PORT`, or preview
  binding values before startup.
- Migration failure: inspect `docker compose --project-name <name> logs migrate`;
  never repair staging manually.
- Preview leak: rerun `preview down`; it is idempotent. If state is missing,
  locate the Compose project by its `signal-audit-pr-` prefix and verify the
  target before removing it.
- Hosted control missing: configure the named GitHub environment variable or
  secret. Do not bypass `requireHostedControls`.
- Production health failure: stop rollout and investigate; never seed or reset
  production to make the check pass.
