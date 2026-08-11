import type { ScoringReleaseSeed } from './types.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value != null && !Array.isArray(value) && typeof value === 'object' ? value as JsonObject : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function empiricalFingerprintReliability(
  seed: ScoringReleaseSeed,
  tier: string | null,
  predictedModel: string | null,
  strongMatch: boolean,
): Record<string, unknown> {
  const calibration = object(seed.artifact['fingerprint_calibration'])
  const baselineSha256 = typeof seed.artifact['content_sha256'] === 'string' ? seed.artifact['content_sha256'] : null
  const base = {
    calibration_available: false,
    calibration_id: typeof calibration?.['calibration_id'] === 'string' ? calibration['calibration_id'] : null,
    calibration_scope: 'formal_gate',
    baseline_sha256: baselineSha256,
    tier,
    predicted_model: predictedModel,
  }
  if (!calibration) return { ...base, unavailable_reason: 'calibration_artifact_missing' }
  if (calibration['baseline_sha256'] !== baselineSha256) return { ...base, unavailable_reason: 'calibration_baseline_mismatch' }
  if (!strongMatch || predictedModel == null) return { ...base, unavailable_reason: 'fingerprint_not_strong' }
  if (tier == null) return { ...base, unavailable_reason: 'calibration_scope_unknown' }
  const rows = Array.isArray(calibration['formal_gate_reliability']) ? calibration['formal_gate_reliability'] : []
  const row = rows.map(object).find((item) => item?.['tier'] === tier && item['predicted_model'] === predictedModel)
  if (!row || row['calibration_available'] !== true) return { ...base, unavailable_reason: 'calibration_not_available' }
  const lower = finiteNumber(row['wilson95_lower'])
  const upper = finiteNumber(row['wilson95_upper'])
  const tierSummary = object(object(calibration['tier_summaries'])?.[tier])
  return {
    ...base,
    calibration_available: true,
    source_replay_sha256: calibration['source_replay_sha256'] ?? null,
    threshold: row['threshold'],
    threshold_operator: calibration['threshold_operator'],
    eligibility_filter: calibration['eligibility_filter'],
    selected: row['selected'],
    correct: row['correct'],
    observed_precision: row['observed_precision'],
    wilson95_lower: lower,
    wilson95_upper: upper,
    wilson95_interval: lower == null || upper == null ? null : [lower, upper],
    coverage: tierSummary?.['coverage'] ?? null,
    tier_total_runs: tierSummary?.['total_runs'] ?? null,
    sample_scope: calibration['sample_scope'],
    limitations: calibration['limitations'],
  }
}
