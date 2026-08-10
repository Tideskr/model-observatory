CREATE TABLE providers (
  slug text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('relay', 'official', 'official_proxy')),
  endpoint_hostname text NOT NULL,
  last_checked_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_groups (
  provider_slug text NOT NULL REFERENCES providers(slug),
  group_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('none', 'price', 'tier')),
  label text NOT NULL,
  multiplier double precision,
  PRIMARY KEY (provider_slug, group_id)
);

CREATE TABLE provider_models (
  provider_slug text NOT NULL,
  group_id text NOT NULL,
  model text NOT NULL,
  PRIMARY KEY (provider_slug, group_id, model),
  FOREIGN KEY (provider_slug, group_id) REFERENCES provider_groups(provider_slug, group_id)
);

CREATE TABLE provider_source_scores (
  provider_slug text NOT NULL,
  group_id text NOT NULL,
  model text NOT NULL,
  source text NOT NULL CHECK (source IN ('vendor', 'donated', 'community')),
  confidence integer CHECK (confidence BETWEEN 0 AND 100),
  samples integer NOT NULL CHECK (samples >= 0),
  PRIMARY KEY (provider_slug, group_id, model, source),
  FOREIGN KEY (provider_slug, group_id, model) REFERENCES provider_models(provider_slug, group_id, model)
);

CREATE TABLE provider_history (
  provider_slug text NOT NULL REFERENCES providers(slug),
  bucket_at timestamptz NOT NULL,
  confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  PRIMARY KEY (provider_slug, bucket_at)
);

CREATE TABLE public_anomalies (
  id text PRIMARY KEY,
  provider_slug text NOT NULL REFERENCES providers(slug),
  observed_at timestamptz NOT NULL,
  channel_display text NOT NULL,
  source text NOT NULL CHECK (source IN ('vendor', 'donated', 'community')),
  model text NOT NULL,
  group_id text,
  probe_id text NOT NULL,
  expected_display text NOT NULL,
  observed_display text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('hard', 'soft')),
  scoring_release_id text NOT NULL REFERENCES scoring_releases(id)
);
CREATE INDEX public_anomalies_provider_time_idx ON public_anomalies(provider_slug, observed_at DESC);
