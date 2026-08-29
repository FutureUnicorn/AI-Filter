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
  -- Tenant-paired, not single-column: see the guarded ALTERs at the end of
  -- this file for why. Kept here too so a fresh database gets the correct
  -- shape without waiting for the ALTER to fix it.
  role_id uuid NOT NULL,
  intake_id uuid NOT NULL,
  source_row_number integer NOT NULL CHECK (source_row_number >= 1),
  candidate_full_name text NOT NULL CHECK (candidate_full_name ~ '[^[:space:]]'),
  candidate_email text NOT NULL CHECK (candidate_email ~ '[^[:space:]]'),
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

-- Postgres trim() strips SPACES ONLY, so `length(trim(x)) > 0` -- and
-- `length(x) > 0` -- accept a value of tabs or newlines. Verified on a
-- real database: length(trim(E'\t\n')) is 2, so E'\t\n' satisfied the
-- old predicate for every column below while being blank to any human
-- reading the record. `~ '[^[:space:]]'` asks the intended question:
-- does this contain at least one non-whitespace character.
--
-- Applied twice: inline above for fresh databases, and as guarded ALTERs
-- here for databases an earlier revision already created, where CREATE
-- TABLE IF NOT EXISTS is a no-op. Guarded rather than DROP/ADD because
-- this file replays on every startup and re-adding a CHECK revalidates
-- every row under a strong lock (the AF-20 replay-cost finding).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'applications'::regclass AND conname = 'applications_candidate_full_name_nonblank'
  ) THEN
    ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_candidate_full_name_check;
    ALTER TABLE applications ADD CONSTRAINT applications_candidate_full_name_nonblank CHECK (candidate_full_name ~ '[^[:space:]]');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'applications'::regclass AND conname = 'applications_candidate_email_nonblank'
  ) THEN
    ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_candidate_email_check;
    ALTER TABLE applications ADD CONSTRAINT applications_candidate_email_nonblank CHECK (candidate_email ~ '[^[:space:]]');
  END IF;
END $$;

-- Cross-tenant misattribution on the application's own parents.
--
-- applications carries organization_id AND references roles and
-- file_intakes. Constraining those separately let an application in
-- organization B name organization A's role or intake -- verified by
-- inserting both against a real database, and both were accepted. That is
-- the row every downstream table hangs off: evidence_outcomes,
-- candidate_decisions and the review queue all reach a tenant through this
-- one, so a misattributed application carries the error into all of them.
--
-- Same class already closed on audit_events (composite FK to memberships)
-- and file_intakes (composite FK to roles). The rule: a table holding both
-- a tenant column and a reference to a tenant-owned row must constrain the
-- pair, not each column separately.
--
-- Guarded rather than DROP/ADD because this file replays on every startup
-- and re-adding a foreign key revalidates every row under a strong lock.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'file_intakes'::regclass AND conname = 'file_intakes_intake_id_organization_id_key'
  ) THEN
    ALTER TABLE file_intakes ADD CONSTRAINT file_intakes_intake_id_organization_id_key
      UNIQUE (intake_id, organization_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'applications'::regclass AND conname = 'applications_role_organization_fkey'
  ) THEN
    ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_role_id_fkey;
    ALTER TABLE applications ADD CONSTRAINT applications_role_organization_fkey
      FOREIGN KEY (role_id, organization_id) REFERENCES roles (role_id, organization_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'applications'::regclass AND conname = 'applications_intake_organization_fkey'
  ) THEN
    ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_intake_id_fkey;
    ALTER TABLE applications ADD CONSTRAINT applications_intake_organization_fkey
      FOREIGN KEY (intake_id, organization_id) REFERENCES file_intakes (intake_id, organization_id)
      ON DELETE RESTRICT;
  END IF;
END $$;
