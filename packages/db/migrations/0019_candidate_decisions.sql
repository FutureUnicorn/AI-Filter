-- AF-51: named human advance/hold/decline recording.
--
-- "The only place a candidate's workflow status changes. Always a named
-- human action with a rationale field; the model has no path to this
-- endpoint."
--
-- Each of those three clauses is made structural here rather than left
-- as a rule someone has to remember.
--
-- "The only place": there is deliberately NO status column on
-- applications. A candidate's workflow status IS the newest row in this
-- append-only log, derived rather than stored, so there is no second
-- copy for anything else to write and no way for the two to disagree.
-- A status column would have to be kept in sync by whatever writes here,
-- and "kept in sync" is the failure this clause is asking to prevent.
--
-- "Always a named human action with a rationale": decided_by_user_id is
-- NOT NULL and must resolve to a membership in the organization whose
-- candidate this is. rationale is NOT NULL and must contain a
-- non-whitespace character. There is no shape of row here that lacks a
-- person or a reason -- unlike evidence_outcomes, where a pipeline row
-- legitimately has neither.
--
-- "The model has no path": this table has no run_id, no provider, no
-- model column -- nothing a machine author could populate. A pipeline
-- row is not merely disallowed, it is unrepresentable. packages/ai also
-- cannot reach packages/db at all (tests/architecture's dependency rule
-- permits ai -> contracts, domain and nothing else), and the HTTP route
-- takes the actor from the session rather than the request body.

CREATE TABLE IF NOT EXISTS candidate_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('advance', 'hold', 'decline')),
  -- Non-whitespace rather than length(trim(...)): Postgres trim() strips
  -- spaces only, so a rationale of E'\t\n' would pass that. Same
  -- predicate 0010 established for the kill-switch reason and 0018 for
  -- a correction reason.
  rationale text NOT NULL CHECK (rationale ~ '[^[:space:]]'),
  decided_by_user_id uuid NOT NULL,
  -- A decision that revises an earlier one names it, so the sequence is
  -- a stored fact rather than an inference from timestamps -- the same
  -- reasoning as 0017, and for the same reason: two rows in the same
  -- microsecond must not be able to invert the order.
  supersedes_decision_id uuid REFERENCES candidate_decisions (decision_id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One composite key, not two independent ones: separate references to
  -- applications and organizations would each hold while still
  -- permitting org B to record a decision about org A's candidate.
  -- Third table to adopt this shape after audit_events and 0016.
  FOREIGN KEY (application_id, organization_id)
    REFERENCES applications (application_id, organization_id),
  -- The decider must be a member of that organization, not merely a user
  -- who exists -- an attribution to someone with no standing in the
  -- tenant names someone who cannot be held to the decision. Same
  -- constraint AF-20 put on audit_events.actor_user_id.
  FOREIGN KEY (organization_id, decided_by_user_id)
    REFERENCES memberships (organization_id, user_id),
  CONSTRAINT candidate_decisions_supersedes_is_not_self
    CHECK (supersedes_decision_id IS DISTINCT FROM decision_id)
);

-- At most one decision may supersede any given decision, so the history
-- is a chain and not a tree. Without it two reviewers deciding
-- concurrently both name the same predecessor and the current status is
-- ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS candidate_decisions_supersedes_unique
  ON candidate_decisions (supersedes_decision_id)
  WHERE supersedes_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS candidate_decisions_application_idx
  ON candidate_decisions (application_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS candidate_decisions_organization_idx
  ON candidate_decisions (organization_id);

-- Append-only, via 0006's generic function. A workflow decision that
-- can be edited after the fact cannot answer "what did we decide, and
-- when" -- which is the whole reason this is a log rather than a column.
DROP TRIGGER IF EXISTS candidate_decisions_append_only ON candidate_decisions;
CREATE TRIGGER candidate_decisions_append_only
  BEFORE UPDATE OR DELETE ON candidate_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Statement-level too: a row trigger never fires for TRUNCATE.
DROP TRIGGER IF EXISTS candidate_decisions_reject_truncate ON candidate_decisions;
CREATE TRIGGER candidate_decisions_reject_truncate
  BEFORE TRUNCATE ON candidate_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
