-- AF-42: operator-triggered kill switch to halt model calls immediately
-- (bad release, cost spike, provider incident).
--
-- SCOPE, stated precisely because the earlier wording ("global") was
-- misleading: this switch halts every organization within ONE
-- deployment's database. It is deliberately NOT a cross-deployment
-- control plane. Per docs/architecture/tenant-isolation.md each pilot
-- gets its own database, schema and credentials, and
-- setInferenceKillSwitch acts on exactly the one databaseUrl it is
-- given, so engaging it in one pilot leaves every other pilot running.
--
-- That is the intended trade-off, not an oversight: a central switch
-- reaching across pilots would require a shared control plane with
-- credentials into every pilot database, which is precisely the
-- cross-tenant coupling the isolation model exists to prevent. The
-- operational consequence an incident responder must know: during a
-- provider incident or cost spike, engage the switch ONCE PER DEPLOYED
-- PILOT. Should that ever become impractical at scale, the fix is a
-- deliberate fan-out mechanism, not widening this row's reach.
--
-- Within one deployment it is genuinely global (not per-organization):
-- an operator responding to an incident needs to halt everything, not
-- one organization at a time.
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
