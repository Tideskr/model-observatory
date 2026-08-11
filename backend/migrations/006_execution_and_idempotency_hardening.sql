ALTER TABLE private_runs
  ADD COLUMN lease_version integer NOT NULL DEFAULT 0;

DROP INDEX private_runs_claim_idx;
CREATE INDEX private_runs_claim_idx
ON private_runs(status, lease_expires_at, created_at)
WHERE status IN ('queued', 'provisioning', 'running', 'scoring');

CREATE TABLE run_job_attempts (
  run_id uuid NOT NULL REFERENCES private_runs(id),
  job_id char(64) NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  PRIMARY KEY (run_id, job_id)
);

ALTER TABLE donations
  ADD COLUMN quote_id uuid,
  ADD COLUMN request_digest char(64),
  ADD COLUMN idempotency_key text;

UPDATE donations
SET quote_id = id,
    request_digest = md5(id::text) || md5('legacy:' || id::text),
    idempotency_key = 'legacy:' || id::text;

ALTER TABLE donations
  ALTER COLUMN quote_id SET NOT NULL,
  ALTER COLUMN request_digest SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ADD CONSTRAINT donations_idempotency_key_unique UNIQUE (idempotency_key);
