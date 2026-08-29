INSERT INTO af11_synthetic_environment_fixture (
  fixture_id,
  display_name,
  contact_email,
  synthetic
)
VALUES (
  'af11-candidate-001',
  'Example Candidate One',
  'candidate-001@example.test',
  true
)
ON CONFLICT (fixture_id) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  contact_email = EXCLUDED.contact_email,
  synthetic = EXCLUDED.synthetic;
