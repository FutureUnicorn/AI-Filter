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

### When extraction fails

Every failure is fail-closed (AF-121). Nothing is printed on stdout, stderr
gets one line, `error: <category>`, and the exit code tells you which
category it was. A response that answers only some criteria prints none of
them. Error lines never contain resume text, rubric text, quotes, the file
name, credentials, or the provider's response body, so they are safe to
paste into a ticket.

| Exit | Category | Meaning | Provider called? |
|---|---|---|---|
| 2 | (usage) | Wrong number of arguments | No |
| 10 | `invalid_rubric` | Rubric is not a non-empty list of objects, or a criterion is missing a non-empty `criterion_id` / `definition`, or repeats an id | No |
| 11 | `empty_input` | Application text is empty or whitespace. Deliberately not "not_found for everything": an empty file is no material at all | No |
| 12 | `unreadable_input` | A file is missing or not UTF-8, or the rubric is not JSON | No |
| 20 | `provider_authentication` | No `OPENAI_API_KEY`, or the provider rejected it (401/403) | Maybe |
| 21 | `provider_timeout` | The request timed out | Yes |
| 22 | `provider_connection` | Could not reach the provider | Yes |
| 23 | `provider_incomplete` | The response status was not `completed` | Yes |
| 24 | `provider_error` | Any other API failure (rate limit, 5xx, bad request) | Yes |
| 30 | `malformed_response` | The output was empty or not JSON | Yes |
| 31 | `schema_violation` | JSON that does not match the schema exactly, or skips, repeats or invents a criterion | Yes |
| 70 | `internal_error` | Anything unforeseen; only the exception class name is shown | Maybe |

A prompt-injection quarantine and a discarded citation are not errors: they
exit 0 and report `quarantined` / `extraction_error` for the affected
criteria.

## 4. Human review — 100% of cards, every time

Read every evidence item against the original resume before it informs any
decision. This script draft is not a decision; it's a starting point for a
human to confirm or correct.

## 5. Compare against the baseline

For a shadow-audit pilot, compare the resulting slate against what the
employer's own process actually did — who advanced, who didn't, and whether
anyone strong got missed either way. That comparison is the actual product
at this stage, not the extraction script itself.

## Not part of the pipeline: the target account list

`target_accounts.py` is the one script here that never touches candidate
material. It qualifies the employer accounts the pilot conversations come
from:

```bash
uv run python scripts/target_accounts.py docs/validation/target-accounts.json
```

See [`../docs/validation/target-account-list.md`](../docs/validation/target-account-list.md)
for the rules it enforces and where the register lives.
