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
same-repository pull request. The workflow checks out
`workflow_run.head_sha`, verifies the checked-out SHA, and deploys through a
runner labelled `signal-audit-preview`.

Each preview receives:

- project: `signal-audit-pr-<PR>-<SHA>`;
- database schema: `pr_<PR>_<SHA>` inside its own disposable Postgres instance;
- bucket: `signal-audit-preview-pr-<PR>-<SHA>` inside its own disposable MinIO instance;
- randomly generated database and storage credentials;
- a state file under ignored `.runtime/previews/` with mode `0600` where the
  operating system supports POSIX permissions;
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
the `signal-audit-staging` Compose volumes.

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

Staging and production environment secrets:

| Name | Requirement |
|---|---|
| `POSTGRES_USER` | environment-only service identity |
| `POSTGRES_PASSWORD` | environment-only secret, at least 20 characters |
| `STORAGE_ACCESS_KEY_ID` | environment-only storage identity |
| `STORAGE_SECRET_ACCESS_KEY` | environment-only secret, at least 20 characters |

Staging and production environment variables:

| Name | Requirement |
|---|---|
| `AF11_ENABLE_HOSTED_ENVIRONMENTS` | `true` after controls are verified |
| `COST_CONTROL_REFERENCE` | provider budget, cap, quota, or alert identifier/URL |
| `COST_CONTROL_OWNER` | named accountable person/team |
| `ADMIN_AUDIT_REFERENCE` | provider audit-log identifier/URL |
| `ADMIN_ROLE_ALLOWLIST` | named role/group, never a shared account |
| `STAGING_URL` / `PRODUCTION_URL` | private validation endpoint |

Do not copy values between environments. Secret values must never appear in Git,
Jira, screenshots, workflow output, or shell history.

## Credential rotation

The official Postgres image applies `POSTGRES_USER`/`POSTGRES_PASSWORD` only
while initialising an empty data directory. Staging and production keep a
persistent `postgres-data` volume, so replacing `POSTGRES_PASSWORD` in the
secret store and redeploying changes what `migrate`, `web`, and `worker`
*send* without changing what the database role *accepts* -- every hosted
service then fails authentication against a role whose password never moved.

Rotation is an operator action performed on the environment's own host, by a
member of `ADMIN_ROLE_ALLOWLIST`. **No workflow performs it.** The staging and
production jobs inject `POSTGRES_PASSWORD` for a deploy and nothing injects
the outgoing password, so `rotate-password` cannot be driven from them as they
stand -- see "Automating rotation" below. Putting the outgoing password into
the GitHub secret store does not make it reachable either; nothing exports it.

1. Replace `POSTGRES_PASSWORD` in the environment's secret store with the new
   password. That is what the next deploy will send; on its own it changes
   nothing about what the database accepts.
2. On the environment's host, supply the outgoing and incoming passwords to a
   single invocation and rotate. `read -rs` takes each value on stdin, so
   neither reaches shell history, and `rotate-password` keeps both out of
   every process's argv:

   ```bash
   read -rsp 'outgoing password: ' POSTGRES_PASSWORD_PREVIOUS; echo
   read -rsp 'new password: ' POSTGRES_PASSWORD; echo
   export POSTGRES_PASSWORD_PREVIOUS POSTGRES_PASSWORD
   node scripts/environment/cli.mjs <staging|production> rotate-password
   unset POSTGRES_PASSWORD_PREVIOUS POSTGRES_PASSWORD
   ```

   The command also requires the environment's other hosted controls to be
   present (`requireHostedControls`: the AF-11 enablement flag, the cost and
   admin references, `POSTGRES_USER`, and the storage credentials --
   `PRODUCTION_VALIDATION_ONLY` as well for production). It locates the
   environment's database through the Compose labels on its running
   containers and network, connects to it from a throwaway container on that
   private network -- which is what subjects the connection to the image's
   `scram-sha-256` host rule, so the outgoing password is genuinely checked
   -- and issues `ALTER ROLE ... WITH PASSWORD`. It refuses to run if
   `POSTGRES_PASSWORD_PREVIOUS` is absent or equal to `POSTGRES_PASSWORD`,
   and fails rather than proceeding if the outgoing password is wrong or the
   environment is not running.

   **From this point until step 3 finishes, the environment is down.** The
   role no longer accepts the password `web` and `worker` are still
   configured with, and the connection pool recycles idle connections within
   about ten seconds, so every request begins failing authentication. Step 3
   rebuilds images, so expect minutes, not seconds. Authentication errors
   during this window are the rotation working, not failing.
3. Run `<staging|production> up` as normal. `migrate`, `web`, and `worker`
   redeploy with the new password, which the role now accepts, and the
   environment recovers.

If step 2 reported success but step 3 failed, do not start over from step 1:
the role is already on the new password. Rerunning `rotate-password` is safe
-- it detects that `POSTGRES_PASSWORD` already authenticates and exits
without changing anything -- but the work left is step 3.

### Automating rotation

Driving this from CI would need a job that injects both the outgoing and the
incoming password from the environment's secrets. That is deliberately not
added here: `production-gate.yml` has no manual trigger, and
`tests/integration/environment-policy.test.ts` asserts it never gains one, so
introducing a dispatchable job that can act on production is a policy decision
for the owners of that rule rather than a detail of this change. Until such a
job exists, treat the host procedure above as the supported path, and record
the rotation against `ADMIN_AUDIT_REFERENCE` like any other administrative
action.

Storage credentials (`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY`) are
MinIO's root user, which MinIO re-reads from the environment on every start
rather than only at initialisation -- confirm this against the deployed MinIO
version before relying on it, but it does not need the ALTER-ROLE-style
rotation step Postgres does.

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
- Hosted database authentication fails right after a `POSTGRES_PASSWORD`
  change: rotation was skipped. See "Credential rotation" above; do not
  reset the volume to force it, which destroys the environment's state.
- Production health failure: stop rollout and investigate; never seed or reset
  production to make the check pass.
