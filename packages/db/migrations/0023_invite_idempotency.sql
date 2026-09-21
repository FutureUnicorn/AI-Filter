-- AF-97 review #88, REV-007: make `POST /api/invites` honour the
-- Idempotency-Key it already requires.
--
-- The route validated the header and then discarded it, so a client that
-- timed out and retried minted a second live invite token, a second
-- `admin_action` audit row (two, once an invite also records a role change)
-- and a second email -- for one action the admin performed once. Requiring a
-- header and ignoring it is worse than not requiring it: it tells the caller
-- the retry is safe.
--
-- The comparable consequential writes in this tree already deduplicate:
-- candidate decisions, import finalization and evidence corrections all carry
-- their key into the persistence layer. An invite mints a bearer credential,
-- so it belongs in that group rather than in the at-least-once one.
--
-- Scoped to (organization_id, idempotency_key) rather than the key alone:
-- keys are client-chosen, and two organizations picking the same string is
-- their business, not a collision. Partial, so the column stays NULL for
-- login tokens, which carry no organization and are not created by a
-- client-supplied key at all -- a plain unique index would collapse every
-- one of those into a single row.
ALTER TABLE magic_link_tokens ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS magic_link_tokens_invite_idempotency_idx
  ON magic_link_tokens (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
