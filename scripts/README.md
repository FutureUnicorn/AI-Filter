# Running the manual evidence pipeline

This is a founder-run pipeline, not a service. No hosted app, no queue, no
database — per `docs/PRODUCT_BOUNDARY.md`, that's deliberate until 3 paid
pilots with repeat/expand intent.

## Setup

```bash
uv sync
export OPENAI_API_KEY=...          # required for extract_evidence.py
export OPENAI_MODEL=gpt-5.6        # optional override; re-verify this is still current
```

## 1. Build a rubric

Fill out `docs/rubric_template.md` with the employer, then transcribe the
approved criteria into a JSON file:

```json
[
  {"criterion_id": "python_production", "definition": "3+ years production Python experience"},
  {"criterion_id": "postgresql", "definition": "PostgreSQL experience"}
]
```

## 2. Get application text

One plain-text file per candidate (resume + any screening answers,
concatenated). Manual copy/paste or a simple PDF-to-text extraction is fine
at this volume — there is no ingestion pipeline yet.

## 3. Extract evidence

```bash
uv run python scripts/extract_evidence.py rubric.json application_jordan_ellis.txt
```

This calls the model once, validates every citation against the source text
(`validate_citations.py`), and discards anything that doesn't check out —
you will see a `[DISCARDED]` line on stderr if that happens, never a silent
wrong answer.

## 4. Human review — 100% of cards, every time

Read every evidence item against the original resume before it informs any
decision. This script draft is not a decision; it's a starting point for a
human to confirm or correct.

## 5. Compare against the baseline

For a shadow-audit pilot, compare the resulting slate against what the
employer's own process actually did — who advanced, who didn't, and whether
anyone strong got missed either way. That comparison is the actual product
at this stage, not the extraction script itself.
