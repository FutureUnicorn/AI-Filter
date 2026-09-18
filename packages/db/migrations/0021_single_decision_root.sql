-- Review #83, P1: concurrent first decisions produced two current states.
--
-- 0020 added a partial unique index on (supersedes_decision_id) WHERE
-- supersedes_decision_id IS NOT NULL, which correctly stops two decisions
-- claiming the same predecessor. It does nothing for the FIRST decision,
-- because that row's supersedes_decision_id is NULL and the index excludes
-- NULLs by its own predicate.
--
-- recordCandidateDecision took `FOR UPDATE` on the current head to serialize,
-- but a candidate with no decisions has no head row, and `FOR UPDATE` cannot
-- lock a row that does not exist. Two first-time transactions therefore both
-- read no head, both inserted with a NULL predecessor, and both committed:
-- two roots, two current states, and a later read that picks one of them by
-- timestamp while the other sits unchained.
--
-- This index makes that state unrepresentable. At most one root decision per
-- (organization_id, application_id), enforced by the database rather than by
-- whichever lock the application layer happens to take. The scope is per
-- application, not global, so different candidates are unaffected.
--
-- The application layer additionally serializes on the parent applications
-- row, which turns a concurrent second attempt into an ordinary supersede
-- rather than a constraint violation. Both are deliberate: the lock gives the
-- correct behaviour, the index guarantees the invariant even if a future
-- caller forgets the lock.

CREATE UNIQUE INDEX IF NOT EXISTS candidate_decisions_single_root_idx
  ON candidate_decisions (organization_id, application_id)
  WHERE supersedes_decision_id IS NULL;
