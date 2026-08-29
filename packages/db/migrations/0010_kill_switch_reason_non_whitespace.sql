-- AF-42 follow-up: 0009 required `length(trim(reason)) > 0`, but
-- Postgres' one-argument trim() strips SPACES only. A reason made of
-- tabs, newlines or other whitespace therefore satisfied the constraint
-- while being blank to an operator reading the incident record, which
-- defeats the non-blank-reason invariant 0009 was added to establish.
--
-- The POSIX class test is the complete form: it requires at least one
-- character that is not whitespace of any kind, rather than enumerating
-- which whitespace to strip.

ALTER TABLE inference_kill_switch DROP CONSTRAINT inference_kill_switch_check;

ALTER TABLE inference_kill_switch
  ADD CONSTRAINT inference_kill_switch_check
  CHECK (
    (engaged AND reason ~ '[^[:space:]]' AND engaged_by_user_id IS NOT NULL)
    OR NOT engaged
  );
