ALTER TABLE donations ALTER COLUMN next_run_at DROP NOT NULL;

UPDATE donations
SET errors = '[]'::jsonb
WHERE jsonb_typeof(errors) IS DISTINCT FROM 'array';

ALTER TABLE donations
  ADD CONSTRAINT donations_errors_array CHECK (jsonb_typeof(errors) = 'array');
