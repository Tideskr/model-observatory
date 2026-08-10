CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scoring_releases (
  id text PRIMARY KEY,
  schema_version integer NOT NULL,
  scoring_version text NOT NULL,
  content_sha256 char(64) NOT NULL UNIQUE,
  source_sha256 char(64) NOT NULL,
  formal_eligible boolean NOT NULL,
  threshold_policy jsonb NOT NULL,
  artifact jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scoring_models (
  release_id text NOT NULL REFERENCES scoring_releases(id),
  model_id text NOT NULL,
  model_kind text NOT NULL CHECK (model_kind IN ('target', 'legacy')),
  PRIMARY KEY (release_id, model_id)
);

CREATE TABLE scoring_probes (
  release_id text NOT NULL REFERENCES scoring_releases(id),
  probe_id text NOT NULL,
  category text NOT NULL,
  prompt text NOT NULL,
  prompt_sha256 char(64) NOT NULL,
  developer_prompt text NOT NULL DEFAULT '',
  developer_prompt_sha256 char(64) NOT NULL,
  normalizer_id text,
  normalizer jsonb,
  scoring_kind text NOT NULL,
  prompt_rewrite_allowed boolean NOT NULL,
  metadata jsonb NOT NULL,
  PRIMARY KEY (release_id, probe_id)
);

CREATE TABLE scoring_probe_templates (
  release_id text NOT NULL REFERENCES scoring_releases(id),
  probe_id text NOT NULL,
  template_id text NOT NULL,
  prompt text NOT NULL,
  prompt_sha256 char(64) NOT NULL,
  metadata jsonb NOT NULL,
  PRIMARY KEY (release_id, probe_id, template_id),
  FOREIGN KEY (release_id, probe_id) REFERENCES scoring_probes(release_id, probe_id)
);

CREATE TABLE scoring_signatures (
  release_id text NOT NULL REFERENCES scoring_releases(id),
  model_id text NOT NULL,
  effort text NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  expected_value text NOT NULL,
  match_rule text NOT NULL CHECK (match_rule IN ('exact', 'exact_or_decimal_or_long_prefix')),
  PRIMARY KEY (release_id, model_id, effort)
);

CREATE TABLE scoring_baseline_cells (
  release_id text NOT NULL REFERENCES scoring_releases(id),
  probe_id text NOT NULL,
  profile text NOT NULL,
  categories jsonb NOT NULL,
  raw_counts jsonb NOT NULL,
  fitted_parameters jsonb NOT NULL,
  quality jsonb NOT NULL,
  PRIMARY KEY (release_id, probe_id, profile)
);

CREATE TABLE scoring_calibrations (
  release_id text NOT NULL REFERENCES scoring_releases(id),
  runtime_signature char(64) NOT NULL,
  runtime_name text NOT NULL,
  formal_eligible boolean NOT NULL,
  required_samples jsonb NOT NULL,
  exact_contracts jsonb NOT NULL,
  thresholds jsonb NOT NULL,
  ood_thresholds jsonb NOT NULL,
  details jsonb NOT NULL,
  PRIMARY KEY (release_id, runtime_signature)
);

CREATE TABLE scoring_verdict_rules (
  release_id text NOT NULL REFERENCES scoring_releases(id),
  priority integer NOT NULL,
  rule_id text NOT NULL,
  title text,
  predicate_id text NOT NULL,
  severe boolean NOT NULL,
  PRIMARY KEY (release_id, rule_id),
  UNIQUE (release_id, priority)
);

CREATE TABLE scoring_revocations (
  release_id text PRIMARY KEY REFERENCES scoring_releases(id),
  reason text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  audit_event_id bigint
);

CREATE TABLE private_runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN (
    'queued', 'provisioning', 'running', 'scoring', 'completed', 'failed',
    'cancelled', 'timed_out', 'incomplete', 'deleted'
  )),
  evidence_source text CHECK (evidence_source IN ('vendor', 'donated', 'community')),
  target_origin text NOT NULL,
  target_hostname text NOT NULL,
  model text NOT NULL,
  run_config jsonb NOT NULL,
  disclosure_version text NOT NULL,
  scoring_release_id text NOT NULL REFERENCES scoring_releases(id),
  owner_token_hash char(64) NOT NULL,
  idempotency_key text NOT NULL,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_token_hash),
  UNIQUE (idempotency_key)
);

CREATE TABLE run_events (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES private_runs(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_events_run_cursor_idx ON run_events(run_id, id);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id_hash char(64),
  payload jsonb NOT NULL,
  previous_hash char(64),
  event_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable table % cannot be updated or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER scoring_releases_immutable
BEFORE UPDATE OR DELETE ON scoring_releases
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER scoring_models_immutable BEFORE UPDATE OR DELETE ON scoring_models
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER scoring_probes_immutable BEFORE UPDATE OR DELETE ON scoring_probes
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER scoring_probe_templates_immutable BEFORE UPDATE OR DELETE ON scoring_probe_templates
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER scoring_signatures_immutable BEFORE UPDATE OR DELETE ON scoring_signatures
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER scoring_baseline_cells_immutable BEFORE UPDATE OR DELETE ON scoring_baseline_cells
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER scoring_calibrations_immutable BEFORE UPDATE OR DELETE ON scoring_calibrations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER scoring_verdict_rules_immutable BEFORE UPDATE OR DELETE ON scoring_verdict_rules
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
