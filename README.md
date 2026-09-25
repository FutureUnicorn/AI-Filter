# AI-Filter (Signal Audit)

An employer-side hiring-signal layer. It takes an employer-approved job rubric and a candidate's application materials, and produces a criterion-by-criterion **evidence card**: supported / partially supported / contradicted / not found / unclear, each with an exact source citation. A human recruiter makes every decision.

## What this is not

- Not an AI-writing or AI-generated-resume detector.
- Not an automatic ranking, scoring, or rejection system.
- Not an ATS replacement, candidate marketplace, or identity/fraud-verification platform.
- Not a full SaaS product yet.

See [`docs/PRODUCT_BOUNDARY.md`](docs/PRODUCT_BOUNDARY.md) for the full, non-negotiable list of what this project must not become before there is paid, repeated customer evidence to justify it.

## Current stage: pre-software, concierge validation

This project has not passed its first paid-pilot gate yet. Per the validation diligence memo this repo is built from, the rule is:

> Do not write product code (hosted app, database, ATS integration, auth, billing) before three paid, repeating pilots.

What's allowed and useful right now is exactly what's in `scripts/`: a manual, script-driven evidence pipeline a founder runs by hand against one employer's data at a time, no hosted app, no multi-tenant database. See [`docs/VALIDATION_STATUS.md`](docs/VALIDATION_STATUS.md) for where things currently stand against the go/no-go gates.

## Repo layout

```
apps/
  web/                    — Next.js delivery shell
  worker/                 — background-processing composition root
packages/
  domain/                 — framework- and vendor-neutral center
  contracts/              — versionable boundary-contract area
  db/                     — persistence adapter boundary
  ai/                     — AI-provider adapter boundary
  ingestion/              — file/parser adapter boundary
  security/               — authentication/authorization adapter boundary
docs/
  PRODUCT_BOUNDARY.md    — what this must never become, and why
  VALIDATION_STATUS.md   — current gate status (problem / value / payment / retention / economics)
  architecture/          — repository dependency rules
  rubric_template.md     — the employer-approved criteria template used per role
evals/                   — model-quality cases and synthetic datasets, separate from tests
scripts/
  schema.py              — the structured evidence-item schema (single source of truth)
  extract_evidence.py    — LLM extraction: rubric + one application -> evidence items
  validate_citations.py  — exact-substring citation validator (the core trust mechanism)
  README.md              — how to run the manual pipeline end to end
tests/                   — Python, architecture, integration, and synthetic fixture tests
```

## TypeScript workspace

### Prerequisites

- Node.js 24 LTS
- Corepack
- Python 3.13 and `uv` for the existing concierge pipeline tests

Enable the pinned pnpm version and install from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Common commands:

```bash
pnpm dev:web             # start the Next.js shell
pnpm dev:worker          # run health only by default; enable processing explicitly
pnpm lint
pnpm typecheck
pnpm test:unit           # deterministic Python citation-validation tests
pnpm test:integration    # requires SIGNAL_AUDIT_RLS_DATABASE_URL; see below
pnpm test                # unit and integration suites
pnpm check:architecture
pnpm build
pnpm check               # complete local quality gate
```

## Local environment infrastructure

AF-11 provides local Postgres and S3-compatible MinIO using synthetic fixtures
only. Docker Engine/Desktop with Compose v2 is required.

```bash
cp .env.example .env.local
pnpm dev:infra
pnpm db:seed
pnpm env:smoke
pnpm dev:web
pnpm dev:worker
```

The durable evidence-extraction worker remains disabled locally until
`WORKER_PROCESSING_ENABLED=true` and the provider/budget settings in
`.env.example` are supplied. Enqueue eligible work with
`POST /api/roles/{roleId}/applications/{applicationId}/evidence-extraction`
and a validated PDF/DOCX `sourceIntakeId`; see
[`docs/operations/evidence-extraction-worker.md`](docs/operations/evidence-extraction-worker.md).

Return the local database and storage to the known synthetic state with
`pnpm dev:reset`. Destructive commands refuse staging and production targets.

### Entering a deployment for the first time

Authentication here is invite-only by design: a sign-in link is only ever
mailed to an address that already holds a membership, and an invite can only
be issued by somebody who already owns an organization. A freshly migrated
database has neither, so one command creates the first organization, user and
owner membership:

Locally, against the database `pnpm dev:infra` starts:

```bash
pnpm bootstrap:owner --organization "Acme" --email owner@acme.test --name "Dana Ops"
```

In a hosted deployment, as a compose service, because `postgres` sits only on
the `private` network (`internal: true`, no published port) and nothing
outside the project can reach it:

```bash
docker compose --profile tools run --rm bootstrap \
  --organization "Acme" --email owner@acme.test --name "Dana Ops"
```

Both run the same script with the same arguments; the second runs it inside
the deployment, with the deployment's own configuration. Unlike `pnpm db:seed`
it is not refused in production.

This is deliberately a command and not an HTTP route. Whatever creates the
first owner cannot itself sit behind authentication, so as a route it would be
an unauthenticated privilege-granting endpoint that has to be disabled after
first use — and "we remembered to disable it" is not a security control.
Requiring database credentials instead puts the authorization on something the
deployment already protects. It writes no synthetic fixtures. Re-running it
converges rather than duplicating: an organization of that name is reused, the
user is matched by email, and the owner membership is upserted (a run that
promotes an existing non-owner member says so). The email is validated with
the same schema the sign-in endpoint parses with, so this command cannot
create an owner that endpoint would refuse to mail.

From there the loop is inside the product:

1. Open `/` and request a sign-in link for that email. In a local environment
   the console sender prints it to the web process's stderr; hosted
   environments require `MAGIC_LINK_EMAIL_*` and mail it for real.
2. The link lands on `/roles`, which resolves the organization from your own
   memberships — no `?organizationId=` to hand-assemble.
3. Owners and admins can invite the rest of the team from that page, which is
   `POST /api/invites`. Redeeming an invite creates the account and its
   membership in one transaction.

Uploading application files still has no UI (`POST /api/roles/:roleId/files`
and the steps after it are reachable only by an HTTP client), so the import
page is not linked from the roles list rather than being linked to a dead end.
Preview, staging, production-shaped validation, secrets, cleanup, cost controls,
and administrator-audit requirements are documented in
[`docs/engineering/environments.md`](docs/engineering/environments.md).

### Running `test:integration` locally

`tests/integration/cross-tenant-access.test.ts` exercises the real memberships
RLS policy (`packages/db/migrations/0004_tenant_scoped_rls.sql`) against a
real, disposable Postgres schema -- it needs `SIGNAL_AUDIT_RLS_DATABASE_URL`
set to a Postgres connection string whose role can `CREATE SCHEMA` and
`CREATE ROLE` -- not merely any reachable database. The probe builds a
throwaway schema and a throwaway login role, exercises the policy as that
role, and drops both afterwards, so it needs the privileges to create them.
The local Postgres `pnpm dev:infra` starts already qualifies. Everything it
creates is namespaced and removed, so pointing it at your local development
database is safe.

```bash
pnpm dev:infra
SIGNAL_AUDIT_RLS_DATABASE_URL=postgresql://signal_audit_local:local-only-password@localhost:5432/signal_audit_local \
  pnpm test:integration
```

CI's integration job sets this the same way against its own disposable
database service.

## Continuous integration

Pull requests and pushes involving `develop` or `main` run independent lint,
typecheck, unit, integration, architecture, and production-build jobs. The
fail-closed aggregate status is named `CI / Required`; repository rules must
require that status before either protected branch can merge.

Production eligibility is evaluated only after a successful `CI` run caused by
a push to `main`, and it checks out the exact SHA that passed. AF-11 must attach
any future production deployment behind that eligibility job. Ordinary pull
request validation is read-only and receives no production credentials.

See [`docs/engineering/ci.md`](docs/engineering/ci.md) for local parity,
protection settings, failure reproduction, and deployment-gate requirements.

The domain is the stable center. Applications and vendor/framework adapters may depend inward on `@signal-audit/domain`; the domain must never depend on Next.js, database, AI, ingestion, security, test, or evaluation implementations. Cross-workspace imports use public `@signal-audit/*` package names, never sibling `src/` paths.

See [`docs/architecture/repository-boundaries.md`](docs/architecture/repository-boundaries.md) for the complete dependency matrix and package-addition procedure.

## Core workflow (manual, for now)

1. Employer approves a job description and 5-10 rubric criteria (`docs/rubric_template.md`).
2. Applications are collected as canonicalized text, one file per candidate.
3. `scripts/extract_evidence.py` runs one model call per application per rubric, producing structured evidence items (state + exact quote + source).
4. `scripts/validate_citations.py` checks every quote exists verbatim in the source text before a human ever sees it. Anything that fails is discarded and flagged, never silently shown as valid.
5. A human reviews 100% of cards, corrects anything wrong, and makes the actual hiring-workflow decision. Nothing here writes to an ATS or changes candidate status.

## Non-negotiable invariants

- Every "supported," "partially supported," or "contradicted" result carries an exact, verbatim source quote.
- "Not found" means no evidence was located in the supplied material — it never means the criterion is claimed absent, and it never triggers rejection on its own.
- No automatic ranking, scoring, recommendation, or contact/advance/reject action. Ever, in this repo.
- No cross-employer data aggregation. Every rubric, application, and result is scoped to one employer's own hiring workflow.
