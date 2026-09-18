-- AF-50: require correction reason and actor.
--
-- "Every correction records who made it and why -- needed for both
-- quality data and future dispute/audit questions."
--
-- 0017 (AF-49) made who/why/what-it-replaced structurally paired: a
-- correction carries all three or none. That stops an *unattributed*
-- correction. It does not yet stop a *meaningless* one, and the gap
-- matters precisely for the use this ticket names. A dispute six months
-- from now asks "who changed this candidate's evidence, and why", and
-- two answers are equally useless:
--
--   correction_reason = '   '          -- present, says nothing
--   corrected_by_user_id = <a user in some other organization>
--
-- Both satisfy 0017. Both make the audit question unanswerable while
-- looking answered, which is worse than a NULL, because a NULL is
-- visibly missing.

DO $correction_attribution$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.evidence_outcomes', current_schema())::regclass
       AND conname = 'evidence_outcomes_correction_reason_not_blank'
  ) THEN
    ALTER TABLE evidence_outcomes
      ADD CONSTRAINT evidence_outcomes_correction_reason_not_blank
      -- Two things this deliberately does NOT use.
      --
      -- Not `length(trim(x)) > 0`. Postgres trim() strips spaces only,
      -- so a reason of E'\t\n' has length 2 after trimming and passes --
      -- verified on Postgres 17, because that was the first version of
      -- this constraint and it accepted a tab-and-newline reason.
      -- `~ '[^[:space:]]'` asks the question actually intended: does
      -- this contain at least one character that is not whitespace.
      --
      -- 0010_kill_switch_reason_non_whitespace.sql reached the same
      -- conclusion for AF-42's operator reason, and its comment names
      -- the same root cause. This is the established predicate for
      -- "non-blank" in this schema, not a departure from convention;
      -- the columns still using length(trim(...)) are the ones that
      -- have not caught up.
      --
      -- Not a naked predicate either. `length(trim(NULL)) > 0` is NULL
      -- and a CHECK only fails on FALSE, so the bare form would admit
      -- pipeline rows correctly but by accident -- the same accident
      -- that let 0016's original agreement checks through. The NULL case
      -- is written down so the next reader need not re-derive whether it
      -- was intended.
      CHECK (correction_reason IS NULL OR correction_reason ~ '[^[:space:]]');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('%I.evidence_outcomes', current_schema())::regclass
       AND conname = 'evidence_outcomes_corrector_membership_fkey'
  ) THEN
    ALTER TABLE evidence_outcomes
      ADD CONSTRAINT evidence_outcomes_corrector_membership_fkey
      -- The corrector must be a member of the organization whose
      -- evidence they corrected, not merely a user who exists. Same
      -- constraint AF-20 put on audit_events.actor_user_id
      -- (audit_events_actor_membership_fkey), for the same reason: an
      -- attribution to someone with no standing in the tenant answers
      -- "who" with a name that cannot be held to it.
      --
      -- Nullable by design and safe: the default MATCH SIMPLE means a
      -- row where any referencing column is NULL satisfies the
      -- constraint, so pipeline rows (corrected_by_user_id IS NULL) pass
      -- untouched while every human correction must resolve to a real
      -- membership.
      --
      -- No ON DELETE clause, so the default NO ACTION applies: a
      -- membership that attributes a correction cannot be deleted out
      -- from under it. That is the intended behaviour for an audit
      -- trail -- offboarding someone must not silently orphan the
      -- record of what they changed -- and it fails as an honest
      -- foreign-key violation naming memberships, which is the lesson
      -- 0006 learned from cascading into an append-only table.
      FOREIGN KEY (organization_id, corrected_by_user_id)
        REFERENCES memberships (organization_id, user_id);
  END IF;
END;
$correction_attribution$;
