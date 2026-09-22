-- AF-102: durable PostgreSQL queue for hosted evidence extraction.
--
-- Jobs are mutable coordination state. They deliberately do not replace
-- append-only evidence_extraction_runs or evidence_outcomes, which remain the
-- audit/result sources of truth. A logical job is unique for one application,
-- canonical source document, published rubric and workflow version.

DO $application_job_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.applications', current_schema())::regclass
       AND conname = 'applications_job_scope_key'
  ) THEN
    ALTER TABLE applications
      ADD CONSTRAINT applications_job_scope_key
      UNIQUE (application_id, organization_id, role_id);
  END IF;
END;
$application_job_key$;

DO $intake_job_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.file_intakes', current_schema())::regclass
       AND conname = 'file_intakes_job_scope_key'
  ) THEN
    ALTER TABLE file_intakes
      ADD CONSTRAINT file_intakes_job_scope_key
      UNIQUE (intake_id, organization_id, role_id);
  END IF;
END;
$intake_job_key$;

DO $rubric_job_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.rubrics', current_schema())::regclass
       AND conname = 'rubrics_job_scope_key'
  ) THEN
    ALTER TABLE rubrics
      ADD CONSTRAINT rubrics_job_scope_key UNIQUE (rubric_id, role_id);
  END IF;
END;
$rubric_job_key$;

CREATE TABLE IF NOT EXISTS evidence_extraction_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  application_id uuid NOT NULL,
  source_intake_id uuid NOT NULL,
  rubric_id uuid NOT NULL,
  workflow_version text NOT NULL CHECK (workflow_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'running', 'completed', 'failed')),
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  lease_owner text CHECK (lease_owner ~ '^[A-Za-z0-9._:-]{1,128}$'),
  lease_expires_at timestamptz,
  failure_code text CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (application_id, organization_id, role_id)
    REFERENCES applications (application_id, organization_id, role_id),
  FOREIGN KEY (source_intake_id, organization_id, role_id)
    REFERENCES file_intakes (intake_id, organization_id, role_id),
  FOREIGN KEY (rubric_id, role_id)
    REFERENCES rubrics (rubric_id, role_id),
  UNIQUE (application_id, source_intake_id, rubric_id, workflow_version),
  CHECK (available_at >= enqueued_at),
  CHECK (started_at IS NULL OR started_at >= enqueued_at),
  CHECK (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)),
  CHECK (failed_at IS NULL OR (started_at IS NOT NULL AND failed_at >= started_at)),
  CHECK (NOT (completed_at IS NOT NULL AND failed_at IS NOT NULL)),
  CHECK (
    (state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((state = 'failed') = (failed_at IS NOT NULL)),
  CHECK (state <> 'completed' OR failure_code IS NULL)
);

CREATE INDEX IF NOT EXISTS evidence_extraction_jobs_claim_idx
  ON evidence_extraction_jobs (available_at, enqueued_at, job_id)
  WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS evidence_extraction_jobs_expired_lease_idx
  ON evidence_extraction_jobs (lease_expires_at, enqueued_at, job_id)
  WHERE state = 'running';
CREATE INDEX IF NOT EXISTS evidence_extraction_jobs_oldest_ready_idx
  ON evidence_extraction_jobs (enqueued_at, job_id)
  WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS evidence_extraction_jobs_application_idx
  ON evidence_extraction_jobs (organization_id, application_id, enqueued_at DESC);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY CHECK (worker_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  service text NOT NULL DEFAULT 'evidence_extraction' CHECK (service = 'evidence_extraction'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_last_seen_idx
  ON worker_heartbeats (last_seen_at DESC);
