-- AF-27: once a rubric version is published, it cannot mutate -- changes
-- require a new version. Unlike AF-20/AF-40's append-only tables, rubrics
-- are legitimately mutable while in draft (that's the whole point of
-- AF-25's edit API), so this can't reuse packages/db's generic
-- reject_append_only_mutation() trigger, which rejects every UPDATE/DELETE
-- unconditionally. This one only rejects a mutation whose OLD row was
-- already published -- the publish transition itself (draft -> published)
-- has OLD.status = 'draft', so it passes through untouched.

CREATE OR REPLACE FUNCTION reject_mutation_of_published_rubric()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION
      'rubric version % of role % is published and immutable; create a new version instead',
      OLD.version, OLD.role_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rubrics_reject_published_mutation ON rubrics;
CREATE TRIGGER rubrics_reject_published_mutation
  BEFORE UPDATE OR DELETE ON rubrics
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_published_rubric();
