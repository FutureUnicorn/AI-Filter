-- AF-11 operational proof table only. AF-13 owns product/domain schemas.
CREATE TABLE IF NOT EXISTS af11_synthetic_environment_fixture (
  fixture_id text PRIMARY KEY,
  display_name text NOT NULL,
  contact_email text NOT NULL CHECK (contact_email LIKE '%@example.test'),
  synthetic boolean NOT NULL CHECK (synthetic),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
