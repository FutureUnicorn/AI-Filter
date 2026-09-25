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

-- REV-001: the extension record.
--
-- Article 12(3) lets a controller take two further months, and the columns
-- on privacy_requests (extended_at, extension_reason, due_at) say that it
-- happened. They cannot say who did it, and due_at is overwritten in place,
-- so on their own they are the kind of record a late response has a motive
-- to rewrite. privacy_request_events cannot hold it either: that ledger is
-- a status history, and an extension changes no status, which its
-- is_a_transition CHECK rightly refuses.
--
-- So an extension gets its own append-only row: who granted it, why, and
-- the deadline before and after. UNIQUE (request_id) makes "a request is
-- extended at most once" a fact the database enforces rather than a check a
-- future caller might skip, and the months CHECK mirrors the domain's 1..2
-- so neither layer is the only thing refusing a meaningless extension.
-- extended_at defaults to the database clock; extendPrivacyRequest writes
-- the same instant it validated, so the timeliness judgement and the record
-- cannot disagree about when the extension was granted.
-- request_id is already the primary key, so this adds no new restriction.
-- It exists so privacy_request_extensions can name the pair in a composite
-- foreign key and make a cross-tenant extension unrepresentable.
ALTER TABLE privacy_requests
  DROP CONSTRAINT IF EXISTS privacy_requests_id_org_key;
ALTER TABLE privacy_requests
  ADD CONSTRAINT privacy_requests_id_org_key UNIQUE (request_id, organization_id);

CREATE TABLE IF NOT EXISTS privacy_request_extensions (
  extension_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES privacy_requests (request_id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  extension_months integer NOT NULL CHECK (extension_months BETWEEN 1 AND 2),
  reason text NOT NULL CHECK (reason ~ '[^[:space:]]'),
  previous_due_at timestamptz NOT NULL,
  new_due_at timestamptz NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
  extended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT privacy_request_extensions_moves_the_deadline_later
    CHECK (new_due_at > previous_due_at)
);

-- The pair, not the two columns independently: an extension must belong to the
-- same tenant as the request it extends. Without this a raw writer could file
-- one organization's extension against another's request and every column
-- would still satisfy its own foreign key. Matches the (grant_id,
-- organization_id) shape 0022_support_access.sql uses.
--
-- Added by ALTER rather than written inline in the table definition above.
-- This file is re-applied on every migrate, and the existence guard on that
-- definition skips the whole statement on a database that already has the
-- table, so a constraint declared inline would never reach an existing
-- deployment. Prose here deliberately avoids spelling out the creation
-- keywords: tests/architecture/retention-classification.test.ts scans this
-- file with a regex and would read them as declaring a table.
ALTER TABLE privacy_request_extensions
  DROP CONSTRAINT IF EXISTS privacy_request_extensions_request_org_fkey;
ALTER TABLE privacy_request_extensions
  ADD CONSTRAINT privacy_request_extensions_request_org_fkey
  FOREIGN KEY (request_id, organization_id)
  REFERENCES privacy_requests (request_id, organization_id) ON DELETE RESTRICT;

-- REV-003: the timeliness CHECK compares extended_at against received_at,
-- which two values a direct writer controls together. After the first
-- month has passed, setting extended_at = received_at + INTERVAL '1 month'
-- and due_at = received_at + INTERVAL '3 months' satisfies every CHECK on
-- the row, so a late extension can be recorded as a timely one and a late
-- response represented as compliant. The constraint checked the shape of
-- the values and never that they described something that actually
-- happened.
--
-- The database clock is the only party here with no motive. This trigger
-- owns extended_at on both tables: it overwrites whatever was supplied
-- with clock_timestamp(), and refuses the write outright once the
-- statutory month has elapsed. Backdating is then not merely refused, it
-- is unrepresentable.
CREATE OR REPLACE FUNCTION pin_privacy_extension_clock() RETURNS trigger
LANGUAGE plpgsql
-- Pinned to the schema this migration ran in. The application
-- schema-qualifies its tables and never sets search_path, so an unpinned
-- function would fail to resolve privacy_requests and refuse every real
-- extension. Same reason support_access_grants_operators_not_revoked pins
-- its own.
SET search_path FROM CURRENT AS $$
DECLARE
  request_received_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'privacy_requests' THEN
    IF NEW.extended_at IS NULL THEN
      RETURN NEW;
    END IF;
    -- Only on the transition into extended. A later unrelated UPDATE must
    -- not re-stamp an extension that was already granted.
    IF TG_OP = 'UPDATE' AND OLD.extended_at IS NOT NULL THEN
      IF NEW.extended_at IS DISTINCT FROM OLD.extended_at THEN
        RAISE EXCEPTION 'privacy request extension timestamp is immutable once granted';
      END IF;
      RETURN NEW;
    END IF;
    request_received_at := NEW.received_at;
    NEW.extended_at := clock_timestamp();
  ELSE
    -- The ledger takes the request row's already-pinned value rather than
    -- reading the clock again. extendPrivacyRequest updates the request
    -- first and inserts here in the same transaction, so by now that value
    -- is the trigger-owned one. Two independent clock reads would leave the
    -- two tables disagreeing by microseconds about one event, which is the
    -- property this ledger exists to hold.
    SELECT received_at, extended_at INTO request_received_at, NEW.extended_at
      FROM privacy_requests WHERE request_id = NEW.request_id;
    -- Fall back to the clock when the request carries no extension yet.
    -- The mirror is what keeps the two tables describing one instant; it
    -- is not the timing control. The check below still applies either
    -- way, so a ledger row can never claim a moment the clock refuses,
    -- and a row written without its request being extended still has to
    -- pass every other constraint on this table rather than being
    -- short-circuited here.
    IF NEW.extended_at IS NULL THEN
      NEW.extended_at := clock_timestamp();
    END IF;
  END IF;

  IF request_received_at IS NULL THEN
    RAISE EXCEPTION 'privacy request extension cannot be timed against a missing request';
  END IF;
  IF NEW.extended_at > request_received_at + INTERVAL '1 month' THEN
    RAISE EXCEPTION 'a privacy request extension must be granted within one month of receipt';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS privacy_requests_pin_extension_clock ON privacy_requests;
CREATE TRIGGER privacy_requests_pin_extension_clock
  BEFORE INSERT OR UPDATE ON privacy_requests
  FOR EACH ROW EXECUTE FUNCTION pin_privacy_extension_clock();

DROP TRIGGER IF EXISTS privacy_request_extensions_pin_clock ON privacy_request_extensions;
CREATE TRIGGER privacy_request_extensions_pin_clock
  BEFORE INSERT ON privacy_request_extensions
  FOR EACH ROW EXECUTE FUNCTION pin_privacy_extension_clock();

DROP TRIGGER IF EXISTS privacy_request_extensions_append_only ON privacy_request_extensions;
CREATE TRIGGER privacy_request_extensions_append_only
  BEFORE UPDATE OR DELETE ON privacy_request_extensions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS privacy_request_extensions_reject_truncate ON privacy_request_extensions;
CREATE TRIGGER privacy_request_extensions_reject_truncate
  BEFORE TRUNCATE ON privacy_request_extensions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
