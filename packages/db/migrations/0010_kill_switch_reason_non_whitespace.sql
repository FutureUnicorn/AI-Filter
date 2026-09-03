-- AF-42 follow-up: 0009 required `length(trim(reason)) > 0`, but
-- Postgres' one-argument trim() strips SPACES only. A reason made of
-- tabs, newlines or other whitespace therefore satisfied the constraint
-- while being blank to an operator reading the incident record, which
-- defeats the non-blank-reason invariant 0009 was added to establish.
--
-- The POSIX class test is the complete form: it requires at least one
-- character that is not whitespace of any kind, rather than enumerating
-- which whitespace to strip.
--
-- `reason IS NOT NULL` is kept alongside it, and dropping it was a real
-- regression rather than redundancy. `reason ~ '...'` against a NULL reason
-- evaluates to NULL, not false, so with `engaged` true and
-- `engaged_by_user_id` present the whole expression is NULL, and Postgres
-- accepts a CHECK that is true OR NULL. Omitting the optional reason would
-- therefore have engaged the kill switch with no reason at all, quietly
-- undoing the mandatory-reason invariant 0008 and 0009 exist to establish.
-- Three-valued logic makes the explicit null test load-bearing.

ALTER TABLE inference_kill_switch DROP CONSTRAINT inference_kill_switch_check;

ALTER TABLE inference_kill_switch
  ADD CONSTRAINT inference_kill_switch_check
  CHECK (
    (engaged AND reason IS NOT NULL AND reason ~ '[^[:space:]]' AND engaged_by_user_id IS NOT NULL)
    OR NOT engaged
  );

-- Second half of the same review. The constraint above guarantees a reason
-- EXISTS at the moment of engaging; it cannot make that reason survive.
-- `inference_kill_switch` is a singleton that each transition overwrites, so
-- disengaging replaces or clears the reason the engage recorded, and the audit
-- row alongside it carries only `admin_action` and an entity_id of
-- "engaged"/"disengaged". The trail can therefore say the switch was engaged
-- on Tuesday and never say why, which is most of the value of an incident
-- record.
--
-- An append-only sibling rather than a column on `audit_events`: that table is
-- shared by every feature in the system and adding to it here would collide
-- with the other branches in flight. This one belongs to the kill switch, and
-- the deletion policy from 0006 applies to audit_events alone, so a transition
-- log kept next to it stays legible on its own terms.

CREATE TABLE IF NOT EXISTS inference_kill_switch_transitions (
  transition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engaged boolean NOT NULL,
  -- Required when engaging, for the same reason as the singleton's CHECK, and
  -- allowed to be absent when disengaging: "the incident is over" needs no
  -- justification the way "stop all inference" does.
  reason text,
  actor_user_id uuid NOT NULL REFERENCES users (user_id),
  request_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT inference_kill_switch_transitions_reason_check CHECK (
    (engaged AND reason IS NOT NULL AND reason ~ '[^[:space:]]')
    OR NOT engaged
  )
);

-- Append-only, enforced the same way 0005 does it for audit_events: a record
-- of why inference was halted is worth nothing if the person who halted it can
-- edit it afterwards.
CREATE OR REPLACE RULE inference_kill_switch_transitions_no_update AS
  ON UPDATE TO inference_kill_switch_transitions DO INSTEAD NOTHING;
CREATE OR REPLACE RULE inference_kill_switch_transitions_no_delete AS
  ON DELETE TO inference_kill_switch_transitions DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS inference_kill_switch_transitions_occurred_at_idx
  ON inference_kill_switch_transitions (occurred_at DESC);
