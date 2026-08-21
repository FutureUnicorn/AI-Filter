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
