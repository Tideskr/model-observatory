ALTER TABLE private_runs
  ADD COLUMN worker_id text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;

CREATE INDEX private_runs_claim_idx
ON private_runs(status, lease_expires_at, created_at)
WHERE status IN ('queued', 'provisioning', 'running');

CREATE TABLE run_observations (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES private_runs(id),
  job_id char(64) NOT NULL,
  probe_id text NOT NULL,
  profile text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'error', 'cancelled')),
  normalized_value text,
  classification text,
  hard_anomaly boolean NOT NULL DEFAULT false,
  elapsed_ms integer,
  safe_error text,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, job_id)
);

CREATE INDEX run_observations_run_idx ON run_observations(run_id, id);
