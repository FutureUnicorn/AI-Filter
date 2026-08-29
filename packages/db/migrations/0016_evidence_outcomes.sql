-- AF-48 prerequisite: persist evidence outcomes.
--
-- Until now nothing stored an EvidenceOutcome. AF-13 defines the
-- thirteen-kind union and packages/contracts validates it at runtime,
-- but it existed only as a value the pipeline returned and then dropped:
-- evidence_extraction_runs (0006) records which model/prompt/schema/
-- rubric produced a run, never what that run concluded. So AF-45's
-- review queue can say whether extraction has happened and nothing
-- about what it found, and AF-48's evidence card -- "criterion, state,
-- exact quote, and source" -- has no source to read from.
--
-- This is deliberately not itself a numbered ticket. It is the same
-- shape as AF-23's session issuance, which AF-23 built because the
-- ticket it was assigned could not exist without it, and flagged in the
-- PR rather than pretending it was in scope. AF-48 through AF-52 all
-- read this table.
--
-- Append-only, not upserted-in-place. That is not a guess about what
-- AF-49 will want: AF-49 is "implement append-only evidence
-- corrections", so a correction is a new row and the current outcome is
-- the newest row for a (application_id, criterion_id) pair. Enforced by
-- 0006's generic reject_append_only_mutation() trigger, which that
-- migration's own comment nominates for exactly this use. A deliberate
-- consequence: there is no UNIQUE (application_id, criterion_id)
-- constraint, because a corrected criterion legitimately has more than
-- one row.
--
-- The outcome itself is stored as jsonb rather than thirteen sets of
-- nullable columns. The union's shapes differ per kind and only
-- packages/contracts' discriminated schema can enforce them; spreading
-- that across ~25 nullable columns plus CHECK constraints would put a
-- second, weaker copy of the same rule in the database where it would
-- drift. kind and criterion_id are lifted out as real columns because
-- they are what every query filters on, and both are asserted against
-- the jsonb so the lifted copies cannot disagree with the record.

CREATE TABLE IF NOT EXISTS evidence_outcomes (
  evidence_outcome_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications (application_id) ON DELETE CASCADE,
  criterion_id text NOT NULL CHECK (length(trim(criterion_id)) > 0),
  kind text NOT NULL CHECK (
    kind IN (
      'supported', 'partially_supported', 'contradicted', 'unclear', 'not_found',
      'processing', 'retrying', 'extraction_error', 'citation_invalid',
      'invalid_source', 'unsupported_file', 'quarantined', 'failed'
    )
  ),
  outcome jsonb NOT NULL,
  -- Which extraction run produced this, when one did. Nullable because a
  -- pipeline-side outcome (quarantined, unsupported_file) can be
  -- recorded without any model call having happened, and because AF-49's
  -- human corrections will have no run at all.
  run_id uuid REFERENCES evidence_extraction_runs (run_id) ON DELETE SET NULL,
  -- clock_timestamp(), not CURRENT_TIMESTAMP: a batch writing every
  -- criterion for one application in a single transaction would
  -- otherwise stamp them all identically, and "the newest row wins" is
  -- how a correction supersedes an original. AF-46 learned the same
  -- lesson from applications.created_at being transaction-start time.
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The lifted columns must agree with the record they were lifted from,
  -- or a query filtering on kind returns rows whose stored outcome says
  -- something else.
  CONSTRAINT evidence_outcomes_kind_matches_payload CHECK (outcome ->> 'kind' = kind),
  CONSTRAINT evidence_outcomes_criterion_matches_payload CHECK (outcome ->> 'criterionId' = criterion_id)
);

-- The review card's read path: newest first for one application.
CREATE INDEX IF NOT EXISTS evidence_outcomes_application_idx
  ON evidence_outcomes (application_id, criterion_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS evidence_outcomes_organization_id_idx
  ON evidence_outcomes (organization_id);

DROP TRIGGER IF EXISTS evidence_outcomes_append_only ON evidence_outcomes;
CREATE TRIGGER evidence_outcomes_append_only
  BEFORE UPDATE OR DELETE ON evidence_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Statement-level as well as row-level: a row trigger never fires for
-- TRUNCATE, so without this an append-only table can still be emptied in
-- one statement. Same pairing 0006 uses.
DROP TRIGGER IF EXISTS evidence_outcomes_reject_truncate ON evidence_outcomes;
CREATE TRIGGER evidence_outcomes_reject_truncate
  BEFORE TRUNCATE ON evidence_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
