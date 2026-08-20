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
docs/
  PRODUCT_BOUNDARY.md    — what this must never become, and why
  VALIDATION_STATUS.md   — current gate status (problem / value / payment / retention / economics)
  rubric_template.md     — the employer-approved criteria template used per role
scripts/
  schema.py              — the structured evidence-item schema (single source of truth)
  extract_evidence.py    — LLM extraction: rubric + one application -> evidence items
  validate_citations.py  — exact-substring citation validator (the core trust mechanism)
  README.md              — how to run the manual pipeline end to end
```

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
