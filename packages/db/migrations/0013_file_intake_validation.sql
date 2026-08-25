-- AF-29: extends file_intakes (AF-28, migration 0012) with the facts
-- validation produces. Nullable throughout: a 'pending' or freshly-
-- 'uploaded' row has none of these yet, only a 'validated' or
-- 'quarantined'/'rejected' one does.

ALTER TABLE file_intakes
  ADD COLUMN IF NOT EXISTS sniffed_mime_type text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  ADD COLUMN IF NOT EXISTS sha256_hash text,
  ADD COLUMN IF NOT EXISTS rejection_reason text;
