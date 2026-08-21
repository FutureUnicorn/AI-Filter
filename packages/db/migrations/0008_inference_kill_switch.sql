-- AF-42: operator-triggered kill switch to halt all model calls
-- immediately (bad release, cost spike, provider incident). Global,
-- not per-tenant: an operator responding to an incident needs to halt
-- everything, not one organization at a time.
--
-- `id boolean PRIMARY KEY DEFAULT true CHECK (id)` is a standard
-- Postgres singleton-table pattern: id can only ever be `true`, and the
-- primary key forbids a second row, so this table structurally cannot
-- hold more than one switch. The seed row keeps the switch off by
-- default so a fresh environment never boots halted.

CREATE TABLE IF NOT EXISTS inference_kill_switch (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  engaged boolean NOT NULL DEFAULT false,
  reason text,
  engaged_by_user_id uuid REFERENCES users (user_id),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((engaged AND reason IS NOT NULL AND engaged_by_user_id IS NOT NULL) OR NOT engaged)
);

INSERT INTO inference_kill_switch (id, engaged) VALUES (true, false)
  ON CONFLICT (id) DO NOTHING;
