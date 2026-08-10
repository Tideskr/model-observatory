import type { DatabasePool } from '../db/connection.js'
import type { ScoringReleaseSeed } from './types.js'

export async function saveScoringRelease(pool: DatabasePool, seed: ScoringReleaseSeed): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const inserted = await client.query(
      `INSERT INTO scoring_releases
       (id, schema_version, scoring_version, content_sha256, source_sha256, formal_eligible, threshold_policy, artifact)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [seed.id, seed.schemaVersion, seed.scoringVersion, seed.contentSha256, seed.sourceSha256, seed.formalEligible, seed.thresholdPolicy, seed.artifact],
    )
    if (inserted.rowCount === 0) {
      const existing = await client.query<{ content_sha256: string }>(
        'SELECT content_sha256 FROM scoring_releases WHERE id = $1',
        [seed.id],
      )
      if (existing.rows[0]?.content_sha256 !== seed.contentSha256) {
        throw new Error(`scoring release ${seed.id} already exists with different content`)
      }
      await client.query('COMMIT')
      return
    }

    for (const model of seed.models) {
      await client.query('INSERT INTO scoring_models(release_id, model_id, model_kind) VALUES ($1,$2,$3)', [seed.id, model.modelId, model.modelKind])
    }
    for (const probe of seed.probes) {
      await client.query(
        `INSERT INTO scoring_probes
         (release_id,probe_id,category,prompt,prompt_sha256,developer_prompt,developer_prompt_sha256,normalizer_id,normalizer,scoring_kind,prompt_rewrite_allowed,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [seed.id, probe.probeId, probe.category, probe.prompt, probe.promptSha256, probe.developerPrompt, probe.developerPromptSha256, probe.normalizerId, probe.normalizer, probe.scoringKind, probe.promptRewriteAllowed, probe.metadata],
      )
    }
    for (const template of seed.templates) {
      await client.query(
        `INSERT INTO scoring_probe_templates
         (release_id,probe_id,template_id,prompt,prompt_sha256,metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
        [seed.id, template.probeId, template.templateId, template.prompt, template.promptSha256, template.metadata],
      )
    }
    for (const signature of seed.signatures) {
      await client.query(
        'INSERT INTO scoring_signatures(release_id,model_id,effort,expected_value,match_rule) VALUES ($1,$2,$3,$4,$5)',
        [seed.id, signature.modelId, signature.effort, signature.expectedValue, signature.matchRule],
      )
    }
    for (const cell of seed.cells) {
      await client.query(
        `INSERT INTO scoring_baseline_cells
         (release_id,probe_id,profile,categories,raw_counts,fitted_parameters,quality) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [seed.id, cell.probeId, cell.profile, cell.categories, cell.rawCounts, cell.fittedParameters, cell.quality],
      )
    }
    for (const calibration of seed.calibrations) {
      await client.query(
        `INSERT INTO scoring_calibrations
         (release_id,runtime_signature,runtime_name,formal_eligible,required_samples,exact_contracts,thresholds,ood_thresholds,details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [seed.id, calibration.runtimeSignature, calibration.runtimeName, calibration.formalEligible, calibration.requiredSamples, calibration.exactContracts, calibration.thresholds, calibration.oodThresholds, calibration.details],
      )
    }
    for (const rule of seed.verdictRules) {
      await client.query(
        `INSERT INTO scoring_verdict_rules
         (release_id,priority,rule_id,title,predicate_id,severe) VALUES ($1,$2,$3,$4,$5,$6)`,
        [seed.id, rule.priority, rule.ruleId, rule.title, rule.predicateId, rule.severe],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function loadScoringRelease(pool: DatabasePool, releaseId: string): Promise<ScoringReleaseSeed> {
  const release = await pool.query<{
    id: string; schema_version: number; scoring_version: string; content_sha256: string; source_sha256: string;
    formal_eligible: boolean; threshold_policy: Record<string, unknown>; artifact: Record<string, unknown>
  }>('SELECT id,schema_version,scoring_version,content_sha256,source_sha256,formal_eligible,threshold_policy,artifact FROM scoring_releases WHERE id=$1', [releaseId])
  const row = release.rows[0]
  if (!row) throw new Error(`scoring release ${releaseId} is not installed`)
  const [models, probes, templates, signatures, cells, calibrations, verdictRules] = await Promise.all([
    pool.query<{ model_id: string; model_kind: 'target' | 'legacy' }>('SELECT model_id,model_kind FROM scoring_models WHERE release_id=$1 ORDER BY model_id', [releaseId]),
    pool.query<{ probe_id: string; category: string; prompt: string; prompt_sha256: string; developer_prompt: string; developer_prompt_sha256: string; normalizer_id: string | null; normalizer: Record<string, unknown> | null; scoring_kind: string; prompt_rewrite_allowed: boolean; metadata: Record<string, unknown> }>('SELECT probe_id,category,prompt,prompt_sha256,developer_prompt,developer_prompt_sha256,normalizer_id,normalizer,scoring_kind,prompt_rewrite_allowed,metadata FROM scoring_probes WHERE release_id=$1 ORDER BY probe_id', [releaseId]),
    pool.query<{ probe_id: string; template_id: string; prompt: string; prompt_sha256: string; metadata: Record<string, unknown> }>('SELECT probe_id,template_id,prompt,prompt_sha256,metadata FROM scoring_probe_templates WHERE release_id=$1 ORDER BY probe_id,template_id', [releaseId]),
    pool.query<{ model_id: string; effort: string; expected_value: string; match_rule: 'exact' | 'exact_or_decimal_or_long_prefix' }>('SELECT model_id,effort,expected_value,match_rule FROM scoring_signatures WHERE release_id=$1 ORDER BY model_id,effort', [releaseId]),
    pool.query<{ probe_id: string; profile: string; categories: unknown[]; raw_counts: Record<string, unknown>; fitted_parameters: Record<string, unknown>; quality: Record<string, unknown> }>('SELECT probe_id,profile,categories,raw_counts,fitted_parameters,quality FROM scoring_baseline_cells WHERE release_id=$1 ORDER BY probe_id,profile', [releaseId]),
    pool.query<{ runtime_signature: string; runtime_name: string; formal_eligible: boolean; required_samples: Record<string, unknown>; exact_contracts: Record<string, unknown>; thresholds: Record<string, unknown>; ood_thresholds: Record<string, unknown>; details: Record<string, unknown> }>('SELECT runtime_signature,runtime_name,formal_eligible,required_samples,exact_contracts,thresholds,ood_thresholds,details FROM scoring_calibrations WHERE release_id=$1 ORDER BY runtime_signature', [releaseId]),
    pool.query<{ priority: number; rule_id: string; title: string | null; predicate_id: string; severe: boolean }>('SELECT priority,rule_id,title,predicate_id,severe FROM scoring_verdict_rules WHERE release_id=$1 ORDER BY priority', [releaseId]),
  ])
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    scoringVersion: row.scoring_version,
    contentSha256: row.content_sha256,
    sourceSha256: row.source_sha256,
    formalEligible: row.formal_eligible,
    thresholdPolicy: row.threshold_policy,
    artifact: row.artifact,
    models: models.rows.map((item) => ({ modelId: item.model_id, modelKind: item.model_kind })),
    probes: probes.rows.map((item) => ({ probeId: item.probe_id, category: item.category, prompt: item.prompt, promptSha256: item.prompt_sha256, developerPrompt: item.developer_prompt, developerPromptSha256: item.developer_prompt_sha256, normalizerId: item.normalizer_id, normalizer: item.normalizer, scoringKind: item.scoring_kind, promptRewriteAllowed: item.prompt_rewrite_allowed, metadata: item.metadata })),
    templates: templates.rows.map((item) => ({ probeId: item.probe_id, templateId: item.template_id, prompt: item.prompt, promptSha256: item.prompt_sha256, metadata: item.metadata })),
    signatures: signatures.rows.map((item) => ({ modelId: item.model_id, effort: item.effort, expectedValue: item.expected_value, matchRule: item.match_rule })),
    cells: cells.rows.map((item) => ({ probeId: item.probe_id, profile: item.profile, categories: item.categories, rawCounts: item.raw_counts, fittedParameters: item.fitted_parameters, quality: item.quality })),
    calibrations: calibrations.rows.map((item) => ({ runtimeSignature: item.runtime_signature, runtimeName: item.runtime_name, formalEligible: item.formal_eligible, requiredSamples: item.required_samples, exactContracts: item.exact_contracts, thresholds: item.thresholds, oodThresholds: item.ood_thresholds, details: item.details })),
    verdictRules: verdictRules.rows.map((item) => ({ priority: item.priority, ruleId: item.rule_id, title: item.title, predicateId: item.predicate_id, severe: item.severe })),
  }
}
