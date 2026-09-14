-- Review #83, P2: the decision and evidence-correction POSTs required an
-- Idempotency-Key by contract (MUTATING_HTTP_METHODS covers every POST) but
-- neither persisted nor replayed one. A client retry after a lost 201
-- recorded a SECOND decision that superseded the first, or a second
-- correction that superseded the first correction.
--
-- That is the part worth being precise about: these are not harmless
-- duplicate deliveries. Both endpoints append to a human audit trail, so a
-- retried request fabricates a decision or a correction that no person made,
-- and the supersede chain then presents it as the current one.
--
-- AF-32 already solved this shape for CSV finalization, but scoped to one
-- intake (import_finalizations holds the key next to the row it finalizes).
-- Decisions and corrections have no such single owning row, so the record
-- lives here, keyed by the endpoint it belongs to.
--
-- Stores the response as well as the key, because replay has to return what
-- the original call returned. Returning a fresh 201 for a retry would be
-- indistinguishable from having recorded a second decision.

CREATE TABLE IF NOT EXISTS idempotent_requests (
  idempotent_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  -- A stable name for the operation, not a URL: two different endpoints may
  -- legitimately see the same client-generated key.
  endpoint text NOT NULL CHECK (length(endpoint) > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) > 0),
  -- sha256 of the canonical request payload. Same key with a different
  -- payload is a client bug and must be refused, not silently replayed as
  -- the earlier request's result.
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  -- NULL until the operation completes. A row with a NULL response is an
  -- in-flight request, which is how a concurrent duplicate is distinguished
  -- from a completed one that can be replayed.
  response_status integer CHECK (response_status IS NULL OR (response_status >= 100 AND response_status < 600)),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK (
    (response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

-- The constraint that makes the whole mechanism work: one record per
-- (organization, endpoint, key). Scoped by organization so one tenant cannot
-- consume or probe another tenant's keys.
CREATE UNIQUE INDEX IF NOT EXISTS idempotent_requests_key_idx
  ON idempotent_requests (organization_id, endpoint, idempotency_key);
