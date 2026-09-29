-- AF-62: candidate-data deletion workflow.
--
-- "On request or retention expiry, delete original documents, canonical
-- text, model outputs, and indexes -- audit metadata is the only thing
-- preserved."
--
-- AF-61 established that DELETE cannot do this. evidence_outcomes and
-- candidate_decisions are append-only, so their rows cannot be removed;
-- applications, file_intakes, canonical_text_extractions and import_rows
-- are all pinned behind foreign keys that terminate at those append-only
-- rows. A deletion workflow built on DELETE would fail on its first
-- statement, every time.
--
-- The move this migration makes is to separate two things AF-61's plan
-- treats as one: removing a ROW and removing its CONTENT. The four pinned
-- tables carry no append-only trigger -- only a foreign key stops the
-- DELETE -- so their candidate-derived columns can be overwritten in
-- place. The row survives to satisfy the references and the audit trail;
-- the candidate's text does not. That erases the large majority of raw
-- candidate data, including the single biggest store (the full extracted
-- document text) which no amount of row-deletion could reach today.
--
-- What this cannot reach is the verbatim quote inside evidence_outcomes
-- and the human-written rationale inside candidate_decisions. Both are
-- append-only against UPDATE as well as DELETE, deliberately, so neither
-- can be redacted in place either. Erasing those requires the design
-- AF-61 named and declined to build -- encrypt candidate-derived text
-- under a per-candidate key and destroy the key -- which is tracked as
-- AF-91. This migration does not pretend otherwise: the erasure ledger
-- below records the residue explicitly on every run, so a claim made to a
-- candidate is written from what actually happened rather than from what
-- the workflow was supposed to achieve.

-- Erasure has to be an explicit state, not something inferred from a
-- column looking empty. Without this, a canonical_text_extractions row
-- whose pages are '[]' is indistinguishable from a document that genuinely
-- extracted to nothing, and AF-63's reconciliation would have to guess
-- which it was looking at. A timestamp also gives the workflow its
-- idempotency check: an already-erased row is skipped rather than
-- overwritten a second time with a fresh placeholder.
ALTER TABLE file_intakes ADD COLUMN IF NOT EXISTS redacted_at timestamptz;
ALTER TABLE canonical_text_extractions ADD COLUMN IF NOT EXISTS redacted_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS redacted_at timestamptz;
ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS redacted_at timestamptz;

-- The receipt, and the "audit metadata" the ticket says is the only thing
-- preserved. One row per erasure, recording what was erased, what could
-- not be, and on whose authority.
CREATE TABLE IF NOT EXISTS candidate_data_erasures (
  erasure_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  application_id uuid NOT NULL,
  -- The ticket names both triggers. They are not interchangeable: an
  -- expiry run is the system acting on a policy, a request is a named
  -- person acting on a candidate's instruction, and only the second has
  -- someone to attribute it to.
  erasure_trigger text NOT NULL CHECK (erasure_trigger IN ('retention_expiry', 'candidate_request')),
  requested_by_user_id uuid REFERENCES users (user_id) ON DELETE RESTRICT,
  executed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- What was actually overwritten or deleted, per surface, with counts.
  surfaces_erased jsonb NOT NULL,
  -- What survived, and why. Non-empty for as long as AF-91 is open, which
  -- is the point: a receipt claiming a clean erasure while quotes remain
  -- would be the false statement this whole design exists to avoid.
  residue jsonb NOT NULL,
  -- A retention-expiry run has no requester and must not invent one; a
  -- candidate request without a named actor is unattributable and must not
  -- be accepted. Enforced as an equivalence so neither direction drifts.
  CONSTRAINT candidate_data_erasures_requester_matches_trigger
    CHECK ((erasure_trigger = 'candidate_request') = (requested_by_user_id IS NOT NULL))
);

-- Tenant scoping through the pair, not through application_id alone.
-- Referencing only application_id would let one organization's erasure
-- receipt point at another organization's application, which is exactly
-- the cross-tenant misattribution the composite key added in 0016 exists
-- to prevent. Guarded because ADD CONSTRAINT has no IF NOT EXISTS and the
-- migrate service replays every file on each run.
DO $candidate_data_erasures_tenant_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.candidate_data_erasures', current_schema())::regclass
       AND conname = 'candidate_data_erasures_application_organization_fkey'
  ) THEN
    ALTER TABLE candidate_data_erasures
      ADD CONSTRAINT candidate_data_erasures_application_organization_fkey
      FOREIGN KEY (application_id, organization_id)
      REFERENCES applications (application_id, organization_id) ON DELETE RESTRICT;
  END IF;
END;
$candidate_data_erasures_tenant_fk$;

CREATE INDEX IF NOT EXISTS candidate_data_erasures_application_idx
  ON candidate_data_erasures (application_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS candidate_data_erasures_org_time_idx
  ON candidate_data_erasures (organization_id, executed_at DESC);

-- Append-only, via 0006's generic function. This ledger is the only
-- surviving evidence that an erasure happened and what it left behind. If
-- it could be edited, the party with a motive to rewrite a receipt that
-- admits residue is the same party the receipt holds accountable.
DROP TRIGGER IF EXISTS candidate_data_erasures_append_only ON candidate_data_erasures;
CREATE TRIGGER candidate_data_erasures_append_only
  BEFORE UPDATE OR DELETE ON candidate_data_erasures
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS candidate_data_erasures_reject_truncate ON candidate_data_erasures;
CREATE TRIGGER candidate_data_erasures_reject_truncate
  BEFORE TRUNCATE ON candidate_data_erasures
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
