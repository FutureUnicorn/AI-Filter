-- AF-54: capture recruiter review timing.
--
-- "Time-per-application in the review queue, needed as the baseline for
-- the review-time-reduction metric."
--
-- What this is for, and what it must not become. The stated purpose is a
-- product baseline: how long reviewing a candidate takes, so AF-55 can
-- say whether the tool made it faster. Time-per-application is also,
-- unavoidably, a measure of an individual's working rate, and a table of
-- those is a performance-management dataset whether or not anyone
-- intended one.
--
-- reviewer_user_id is stored because a span with no actor cannot be
-- deduplicated (the same person opening a candidate twice) and cannot be
-- excluded when someone leaves. It is deliberately NOT indexed for
-- reviewer-first lookup, and packages/db offers no function that
-- aggregates by reviewer -- the read path AF-55 needs groups by
-- application. That is a structural choice, not a policy note: the
-- easiest query to write should be the one the ticket asks for.
--
-- Spans are append-only for the same reason every other record here is:
-- a baseline that can be edited after the fact cannot serve as one.

CREATE TABLE IF NOT EXISTS review_timing_spans (
  review_timing_span_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  reviewer_user_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  -- Active milliseconds, which is NOT ended_at - started_at. A tab left
  -- open overnight would otherwise record eight hours of "review". The
  -- client accumulates only time the page was actually focused, and the
  -- idle cutoff below records when that accumulation was truncated.
  active_ms integer NOT NULL CHECK (active_ms >= 0),
  -- True when an idle cutoff ended the span rather than the reviewer
  -- navigating away. Stored rather than inferred so a later reader can
  -- exclude truncated spans, or count them, and knows which is which --
  -- an untruncated span and a truncated one mean different things and a
  -- median over both silently mixes them.
  truncated_by_idle boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT review_timing_spans_ordered CHECK (ended_at >= started_at),
  -- Active time cannot exceed the wall-clock span it sits inside. This
  -- is the one check that catches a client sending a fabricated or
  -- miscomputed duration, which is the failure mode that would quietly
  -- corrupt the baseline.
  CONSTRAINT review_timing_spans_active_within_wall_clock
    CHECK (active_ms <= (EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::bigint + 1000),
  FOREIGN KEY (application_id, organization_id)
    REFERENCES applications (application_id, organization_id),
  FOREIGN KEY (organization_id, reviewer_user_id)
    REFERENCES memberships (organization_id, user_id)
);

-- Application-first, because that is the grain AF-55 reports on. There
-- is deliberately no (reviewer_user_id, ...) index: the absence is the
-- point, per the note above.
CREATE INDEX IF NOT EXISTS review_timing_spans_application_idx
  ON review_timing_spans (application_id, started_at);
CREATE INDEX IF NOT EXISTS review_timing_spans_organization_idx
  ON review_timing_spans (organization_id);

DROP TRIGGER IF EXISTS review_timing_spans_append_only ON review_timing_spans;
CREATE TRIGGER review_timing_spans_append_only
  BEFORE UPDATE OR DELETE ON review_timing_spans
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS review_timing_spans_reject_truncate ON review_timing_spans;
CREATE TRIGGER review_timing_spans_reject_truncate
  BEFORE TRUNCATE ON review_timing_spans
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
