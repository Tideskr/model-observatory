CREATE TABLE provider_registry_versions (
  content_sha256 char(64) PRIMARY KEY,
  schema_version integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE providers
  ALTER COLUMN last_checked_at DROP NOT NULL,
  ADD COLUMN active boolean NOT NULL DEFAULT true;

CREATE TABLE provider_domains (
  hostname text PRIMARY KEY,
  provider_slug text NOT NULL REFERENCES providers(slug),
  role text NOT NULL CHECK (role IN ('primary', 'alias')),
  default_base_path text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired'))
);

ALTER TABLE provider_groups ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE provider_models ADD COLUMN active boolean NOT NULL DEFAULT true;

ALTER TABLE provider_source_scores
  ADD COLUMN availability integer CHECK (availability BETWEEN 0 AND 100),
  ADD COLUMN attempted_samples integer NOT NULL DEFAULT 0 CHECK (attempted_samples >= 0),
  ADD COLUMN inconclusive_samples integer NOT NULL DEFAULT 0 CHECK (inconclusive_samples >= 0),
  ADD COLUMN verified_samples integer NOT NULL DEFAULT 0 CHECK (verified_samples >= 0),
  ADD COLUMN declared_samples integer NOT NULL DEFAULT 0 CHECK (declared_samples >= 0);

ALTER TABLE donations
  ADD COLUMN provider_slug text REFERENCES providers(slug),
  ADD COLUMN group_id text,
  ADD COLUMN detected_group_id text,
  ADD COLUMN group_attribution text NOT NULL DEFAULT 'pending' CHECK (group_attribution IN ('pending','verified','donor_declared')),
  ADD COLUMN phase text NOT NULL DEFAULT 'queued',
  ADD COLUMN progress_current integer NOT NULL DEFAULT 0,
  ADD COLUMN progress_total integer NOT NULL DEFAULT 0,
  ADD COLUMN current_model text,
  ADD COLUMN next_run_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN quota_spent_usd numeric(14,6) NOT NULL DEFAULT 0,
  ADD COLUMN quota_reserved_usd numeric(14,6) NOT NULL DEFAULT 0,
  ADD COLUMN errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN worker_id text,
  ADD COLUMN lease_expires_at timestamptz;

ALTER TABLE donations
  ADD CONSTRAINT donations_provider_group_fk FOREIGN KEY (provider_slug, group_id)
  REFERENCES provider_groups(provider_slug, group_id);

CREATE INDEX donations_schedule_idx ON donations(status,next_run_at,lease_expires_at)
WHERE status IN ('quarantined','active');

CREATE TABLE donation_cycles (
  id uuid PRIMARY KEY,
  donation_id uuid NOT NULL REFERENCES donations(id),
  status text NOT NULL CHECK (status IN ('scheduled','running','completed','blocked')),
  attribution text NOT NULL CHECK (attribution IN ('verified','donor_declared')),
  reserved_cost_usd numeric(14,6) NOT NULL,
  actual_cost_usd numeric(14,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE donation_test_runs (
  cycle_id uuid NOT NULL REFERENCES donation_cycles(id),
  donation_id uuid NOT NULL REFERENCES donations(id),
  private_run_id uuid NOT NULL UNIQUE REFERENCES private_runs(id),
  provider_slug text NOT NULL,
  group_id text NOT NULL,
  model text NOT NULL,
  attribution text NOT NULL CHECK (attribution IN ('verified','donor_declared')),
  outcome text CHECK (outcome IN ('pass','fail','inconclusive','unavailable')),
  successful_requests integer,
  attempted_requests integer,
  estimated_cost_usd numeric(14,6),
  excluded boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  PRIMARY KEY (cycle_id, model),
  FOREIGN KEY (provider_slug,group_id,model) REFERENCES provider_models(provider_slug,group_id,model)
);

CREATE INDEX donation_test_runs_pending_idx ON donation_test_runs(completed_at) WHERE completed_at IS NULL;
