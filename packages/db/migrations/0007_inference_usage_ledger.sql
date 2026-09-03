-- AF-41: track tokens per tenant and per model, so a runaway loop or
-- bad actor can be capped before it produces an unbounded bill. One
-- row per (organization, model, period); period_start's granularity
-- (daily, monthly, ...) is entirely up to whatever value the
-- application passes in -- this table has no opinion about it.
--
-- This is a running total, not an append-only log (contrast
-- audit_events/evidence_extraction_runs, 0005/0006): each call
-- increments the existing row for its period via INSERT ... ON
-- CONFLICT ... DO UPDATE, rather than inserting a new row every time.

CREATE TABLE IF NOT EXISTS inference_usage_ledger (
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  model text NOT NULL CHECK (length(model) > 0),
  period_start date NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, model, period_start)
);

-- A reservation is deliberately a separate, durable record rather than an
-- amount remembered by the caller. The provider call can succeed while the
-- worker loses its response; retrying settlement must then be a harmless
-- read of an already-settled reservation, not a second adjustment to the
-- aggregate ledger.
CREATE TABLE IF NOT EXISTS inference_usage_reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  model text NOT NULL CHECK (length(model) > 0),
  period_start date NOT NULL,
  reserved_input_tokens bigint NOT NULL CHECK (reserved_input_tokens >= 0),
  reserved_output_tokens bigint NOT NULL CHECK (reserved_output_tokens >= 0),
  settled_at timestamptz,
  actual_input_tokens bigint,
  actual_output_tokens bigint,
  CHECK (
    (settled_at IS NULL AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL)
    OR (
      settled_at IS NOT NULL
      AND actual_input_tokens IS NOT NULL AND actual_input_tokens >= 0
      AND actual_output_tokens IS NOT NULL AND actual_output_tokens >= 0
    )
  )
);
