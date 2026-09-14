-- AF-30: one canonical text extraction per validated file intake. Pages
-- stored as JSONB for the same reason as rubrics' criteria (AF-25):
-- always read/written as one ordered unit, never queried per-page.
-- UNIQUE on intake_id makes extraction idempotent -- re-running against
-- the same intake finds the existing row rather than producing a
-- second, competing extraction of the same immutable uploaded bytes.

CREATE TABLE IF NOT EXISTS canonical_text_extractions (
  extraction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id uuid NOT NULL UNIQUE REFERENCES file_intakes (intake_id) ON DELETE CASCADE,
  pages jsonb NOT NULL,
  total_pages integer NOT NULL CHECK (total_pages > 0),
  quality text NOT NULL CHECK (quality IN ('full', 'partial', 'empty')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
