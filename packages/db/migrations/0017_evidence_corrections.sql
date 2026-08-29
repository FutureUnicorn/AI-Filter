-- AF-49: append-only evidence corrections.
--
-- "Recruiter corrections never overwrite the original AI output --
-- before/after state is preserved for every correction."
--
-- 0016 already made overwriting impossible: evidence_outcomes rejects
-- UPDATE, DELETE and TRUNCATE, and the current outcome for a criterion
-- is simply its newest row. So the append half of this ticket needs no
-- new machinery. What it does need is the *pairing*: "before/after
-- state is preserved for every correction" is a claim about being able
-- to say which outcome a given correction replaced, and reconstructing
-- that from timestamps alone is an inference, not a record. Two rows
-- written in the same microsecond, or a correction racing a
-- re-extraction, and the inference is wrong with nothing to detect it.
-- supersedes_evidence_outcome_id makes the before/after pair a stored
-- fact.

ALTER TABLE evidence_outcomes
  ADD COLUMN IF NOT EXISTS corrected_by_user_id uuid REFERENCES users (user_id);

ALTER TABLE evidence_outcomes
  ADD COLUMN IF NOT EXISTS correction_reason text;

ALTER TABLE evidence_outcomes
  ADD COLUMN IF NOT EXISTS supersedes_evidence_outcome_id uuid REFERENCES evidence_outcomes (evidence_outcome_id);

-- Guarded, because ADD CONSTRAINT has no IF NOT EXISTS and the migrate
-- service replays every file on every run. Re-adding a CHECK is not
-- free either: it takes a strong lock and revalidates every row, so on
-- a table that grows with every extraction the cost of a replay would
-- grow with it.
DO $evidence_correction_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.evidence_outcomes', current_schema())::regclass
       AND conname = 'evidence_outcomes_correction_is_attributed'
  ) THEN
    ALTER TABLE evidence_outcomes
      ADD CONSTRAINT evidence_outcomes_correction_is_attributed
      -- A correction is exactly a row with a human behind it, and such a
      -- row must say both who and why. Structural, not merely
      -- documented: an unattributed correction is indistinguishable from
      -- a pipeline result, which is the one thing this ticket exists to
      -- prevent. AF-50 tightens `why` from present to non-blank and
      -- enforces it at the request boundary; this makes the pairing
      -- impossible to violate at all.
      CHECK (
        (corrected_by_user_id IS NULL) = (correction_reason IS NULL)
        AND (corrected_by_user_id IS NULL) = (supersedes_evidence_outcome_id IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.evidence_outcomes', current_schema())::regclass
       AND conname = 'evidence_outcomes_correction_has_no_run'
  ) THEN
    ALTER TABLE evidence_outcomes
      ADD CONSTRAINT evidence_outcomes_correction_has_no_run
      -- A row is either something the pipeline produced or something a
      -- human wrote. Both at once would make "was this the AI's output
      -- or the recruiter's?" unanswerable, which is precisely the
      -- question an audit of a hiring decision asks.
      CHECK (corrected_by_user_id IS NULL OR run_id IS NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.evidence_outcomes', current_schema())::regclass
       AND conname = 'evidence_outcomes_supersedes_is_not_self'
  ) THEN
    ALTER TABLE evidence_outcomes
      ADD CONSTRAINT evidence_outcomes_supersedes_is_not_self
      CHECK (supersedes_evidence_outcome_id IS DISTINCT FROM evidence_outcome_id);
  END IF;
END;
$evidence_correction_constraints$;

-- At most one correction may supersede any given outcome. Without this
-- the history is a tree rather than a chain: two recruiters correcting
-- the same criterion concurrently both name the same predecessor, both
-- inserts succeed, and "the before state" for the surviving row is
-- ambiguous. Partial, so the many rows that supersede nothing do not
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS evidence_outcomes_supersedes_unique
  ON evidence_outcomes (supersedes_evidence_outcome_id)
  WHERE supersedes_evidence_outcome_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_outcomes_corrected_by_idx
  ON evidence_outcomes (corrected_by_user_id)
  WHERE corrected_by_user_id IS NOT NULL;
