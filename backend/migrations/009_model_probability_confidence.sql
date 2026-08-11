ALTER TABLE donation_test_runs
  ADD COLUMN model_probability double precision CHECK (model_probability BETWEEN 0 AND 1);

UPDATE donation_test_runs d
SET model_probability = (r.report #>> ARRAY['summary','probability','conditional_relative_probability',d.model])::double precision
FROM run_reports r
WHERE r.run_id = d.private_run_id
  AND r.report #>> '{summary,probability,formal_eligible}' = 'true'
  AND r.report #>> ARRAY['summary','probability','conditional_relative_probability',d.model] IS NOT NULL;

WITH aggregates AS (
  SELECT provider_slug,group_id,model,round(100.0*avg(model_probability))::integer AS confidence,
    count(model_probability)::integer AS samples,
    count(*) FILTER (WHERE attribution='verified' AND model_probability IS NOT NULL)::integer AS verified_samples,
    count(*) FILTER (WHERE attribution='donor_declared' AND model_probability IS NOT NULL)::integer AS declared_samples
  FROM donation_test_runs
  WHERE excluded=false AND completed_at>=now()-interval '30 days'
  GROUP BY provider_slug,group_id,model
)
UPDATE provider_source_scores s
SET confidence=a.confidence,samples=a.samples,verified_samples=a.verified_samples,declared_samples=a.declared_samples
FROM aggregates a
WHERE s.provider_slug=a.provider_slug AND s.group_id=a.group_id AND s.model=a.model AND s.source='donated';

DELETE FROM provider_history h
USING (SELECT DISTINCT provider_slug FROM donation_test_runs) d
WHERE h.provider_slug=d.provider_slug AND h.bucket_at=date_trunc('day',now());

INSERT INTO provider_history(provider_slug,bucket_at,confidence)
SELECT provider_slug,date_trunc('day',now()),round(avg(confidence))::integer
FROM provider_source_scores
WHERE source IN ('donated','community') AND confidence IS NOT NULL
  AND provider_slug IN (SELECT DISTINCT provider_slug FROM donation_test_runs)
GROUP BY provider_slug
ON CONFLICT (provider_slug,bucket_at) DO UPDATE SET confidence=excluded.confidence;
