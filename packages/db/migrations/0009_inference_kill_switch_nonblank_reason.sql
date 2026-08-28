-- AF-42 follow-up: the original CHECK only required `reason IS NOT NULL`
-- when engaged, so `reason = ''` satisfied it -- defeating the actual
-- requirement that an operator give a real reason. `reason` stays
-- nullable for the disengaged case (unchanged); only the engaged branch
-- now also requires it to be non-blank.

ALTER TABLE inference_kill_switch DROP CONSTRAINT inference_kill_switch_check;

ALTER TABLE inference_kill_switch
  ADD CONSTRAINT inference_kill_switch_check
  CHECK (
    (engaged AND reason IS NOT NULL AND length(trim(reason)) > 0 AND engaged_by_user_id IS NOT NULL)
    OR NOT engaged
  );
