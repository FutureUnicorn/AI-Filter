-- Fictional record tied to the synthetic object in this AF-69 drill.
WITH organization AS (
  INSERT INTO organizations (name) VALUES ('AF-69 Synthetic Employer') RETURNING organization_id
), actor AS (
  INSERT INTO users (email, display_name)
  VALUES ('af69-operator@example.test', 'Synthetic Operator') RETURNING user_id
), role AS (
  INSERT INTO roles (organization_id, title, created_by_user_id)
  SELECT organization_id, 'Synthetic Role', user_id FROM organization CROSS JOIN actor
  RETURNING role_id, organization_id, created_by_user_id
)
INSERT INTO file_intakes
  (organization_id, role_id, storage_key, declared_filename, declared_mime_type,
   status, created_by_user_id, sniffed_mime_type, size_bytes, sha256_hash)
SELECT organization_id, role_id, 'synthetic/af69-document.txt',
  'af69-document.txt', 'text/plain', 'validated', created_by_user_id,
  'text/plain', 84, '62df4d5144a526889f80b46e9b75fef304cdab3296ba7bb3defb3013f1c4b1ca'
FROM role;
