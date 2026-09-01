-- AF-64: privacy export/delete requests.
--
-- "A tracked request/response lifecycle for candidate or employer data
-- export and deletion requests, with a due date and status."
--
-- AF-62 built the machinery that erases a candidate's data. This is the
-- obligation around it: who asked, for what, by when, and what they were
-- actually told. The due date is the reason this table exists rather than
-- a status column on something else -- a deletion that happened is not the
-- same claim as a deletion that happened in time, and only one of those is
-- what a data subject is owed.
--
-- The deadline is a calendar month from receipt, not thirty days. GDPR
-- Article 12(3) says "within one month of receipt of the request", and
-- calendar months are not a fixed length: a request received on 31 January
-- is due 28 February, which a 30-day rule would put on 2 March -- two days
-- into a breach, silently. Postgres INTERVAL '1 month' does the calendar
-- arithmetic, including the end-of-month clamp, so the constraint below and
-- the domain helper agree by construction rather than by coincidence.
--
-- Article 12(3) also allows two further months "taking into account the
-- complexity and number of the requests", but requires the data subject to
-- be informed of the extension WITHIN the original month. An extension
-- recorded after that month has already elapsed is not an extension, it is
-- a late response being backdated, so the schema refuses to record one.

CREATE TABLE IF NOT EXISTS privacy_requests (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  -- A candidate asking about their own application, or an employer asking
  -- about their tenant's data. Different scopes, same obligation.
  subject_kind text NOT NULL CHECK (subject_kind IN ('candidate', 'employer')),
  application_id uuid,
  request_kind text NOT NULL CHECK (request_kind IN ('export', 'delete')),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'in_progress', 'completed', 'refused')),
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_at timestamptz NOT NULL,
  extended_at timestamptz,
  extension_reason text,
  completed_at timestamptz,
  refusal_reason text,
  -- What the requester was actually told, including any residue AF-62
  -- could not erase. Null until the request is resolved.
  outcome jsonb,
  received_by_user_id uuid NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
  resolved_by_user_id uuid REFERENCES users (user_id) ON DELETE RESTRICT,

  -- A candidate request is about one application and must name it; an
  -- employer request is tenant-wide and has none to name. Stated as an
  -- equivalence so neither direction drifts.
  CONSTRAINT privacy_requests_subject_names_application
    CHECK ((subject_kind = 'candidate') = (application_id IS NOT NULL)),
  -- A resolved request has a resolver and a timestamp; an open one has
  -- neither. Without this, "completed" is a word rather than a record.
  CONSTRAINT privacy_requests_completion_is_recorded
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT privacy_requests_refusal_has_a_reason
    CHECK ((status = 'refused') = (refusal_reason IS NOT NULL)),
  CONSTRAINT privacy_requests_resolution_is_attributed
    CHECK ((status IN ('completed', 'refused')) = (resolved_by_user_id IS NOT NULL)),
  CONSTRAINT privacy_requests_extension_has_a_reason
    CHECK ((extended_at IS NULL) = (extension_reason IS NULL)),
  -- Article 12(3): the data subject must be told about the extension
  -- within the original month.
  CONSTRAINT privacy_requests_extension_is_timely
    CHECK (extended_at IS NULL OR extended_at <= received_at + INTERVAL '1 month'),
  -- The statutory ceiling: one month, plus at most two more.
  CONSTRAINT privacy_requests_due_within_statutory_maximum
    CHECK (due_at > received_at AND due_at <= received_at + INTERVAL '3 months'),
  -- An unextended request cannot quietly be given a later deadline than
  -- the month it is owed.
  CONSTRAINT privacy_requests_unextended_due_in_one_month
    CHECK (extended_at IS NOT NULL OR due_at <= received_at + INTERVAL '1 month'),

  -- Tenant scoping through the pair, the shape 0016, 0019 and 0023 use.
  FOREIGN KEY (application_id, organization_id)
    REFERENCES applications (application_id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS privacy_requests_org_due_idx
  ON privacy_requests (organization_id, due_at)
  WHERE status IN ('received', 'in_progress');

-- The lifecycle itself. privacy_requests holds the current state; this
-- holds how it got there. A status column alone cannot evidence that a
-- request was answered on time, because it is overwritten on every
-- change -- the one record that matters is the one a late response has a
-- motive to remove.
CREATE TABLE IF NOT EXISTS privacy_request_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES privacy_requests (request_id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL
    CHECK (to_status IN ('received', 'in_progress', 'completed', 'refused')),
  note text NOT NULL CHECK (note ~ '[^[:space:]]'),
  actor_user_id uuid NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT privacy_request_events_is_a_transition
    CHECK (from_status IS DISTINCT FROM to_status)
);

CREATE INDEX IF NOT EXISTS privacy_request_events_request_idx
  ON privacy_request_events (request_id, occurred_at);

DROP TRIGGER IF EXISTS privacy_request_events_append_only ON privacy_request_events;
CREATE TRIGGER privacy_request_events_append_only
  BEFORE UPDATE OR DELETE ON privacy_request_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS privacy_request_events_reject_truncate ON privacy_request_events;
CREATE TRIGGER privacy_request_events_reject_truncate
  BEFORE TRUNCATE ON privacy_request_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
