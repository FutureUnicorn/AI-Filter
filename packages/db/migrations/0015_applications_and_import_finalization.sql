-- AF-32: idempotent import finalization. Adds the applications table
-- the whole intake/validate/parse/preview pipeline (AF-28-31) has been
-- building toward, plus the bookkeeping that makes finalizing a CSV
-- import both atomic and safely retryable.
--
-- import_finalizations is the idempotency record: at most one per
-- intake (UNIQUE on intake_id), storing the exact idempotency key and
-- mapping used. A retry with the same key and mapping is a genuine
-- replay; a different key or a different mapping against an
-- already-finalized intake is a real conflict, not a silent overwrite.
--
-- import_rows is the per-row ledger the ticket asks for directly:
-- "every input row is accounted for" means one row here per CSV data
-- row, not just an aggregate count -- outcome plus (for processed) the
-- application it created or (for failed) why it didn't.

ALTER TABLE file_intakes DROP CONSTRAINT IF EXISTS file_intakes_status_check;

ALTER TABLE file_intakes
  ADD CONSTRAINT file_intakes_status_check
  CHECK (status IN ('pending', 'uploaded', 'validated', 'quarantined', 'rejected', 'imported'));

CREATE TABLE IF NOT EXISTS applications (
  application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles (role_id) ON DELETE CASCADE,
  intake_id uuid NOT NULL REFERENCES file_intakes (intake_id) ON DELETE RESTRICT,
  source_row_number integer NOT NULL CHECK (source_row_number >= 1),
  candidate_full_name text NOT NULL CHECK (length(trim(candidate_full_name)) > 0),
  candidate_email text NOT NULL CHECK (length(trim(candidate_email)) > 0),
  external_reference_id text,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS applications_role_id_idx ON applications (role_id);
CREATE INDEX IF NOT EXISTS applications_intake_id_idx ON applications (intake_id);

CREATE TABLE IF NOT EXISTS import_finalizations (
  finalization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id uuid NOT NULL UNIQUE REFERENCES file_intakes (intake_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) > 0),
  mapping jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS import_rows (
  import_row_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id uuid NOT NULL REFERENCES file_intakes (intake_id) ON DELETE CASCADE,
  row_number integer NOT NULL CHECK (row_number >= 1),
  outcome text NOT NULL CHECK (outcome IN ('processed', 'failed', 'skipped')),
  application_id uuid REFERENCES applications (application_id) ON DELETE SET NULL,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((outcome = 'processed') = (application_id IS NOT NULL)),
  CHECK ((outcome = 'failed') = (failure_reason IS NOT NULL)),
  UNIQUE (intake_id, row_number)
);

CREATE INDEX IF NOT EXISTS import_rows_intake_id_idx ON import_rows (intake_id);
