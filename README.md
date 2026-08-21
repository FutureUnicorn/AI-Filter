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
pnpm dev:worker          # run the credential-free worker shell
pnpm lint
pnpm typecheck
pnpm test                # TypeScript and existing Python tests
pnpm check:architecture
pnpm build
pnpm check               # complete local quality gate
```

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
