import type { RunStatus } from '../contracts/common.js'
import type { RunRecord, StoredObservation } from '../store/run-store.js'
import type { ProbeJob } from '../executor/job-plan.js'
import type { ScoringCalibrationSeed, ScoringCellSeed, ScoringReleaseSeed } from './types.js'

const TARGET_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const
const REFUSALS = ['cannot provide', "can't provide", 'unable to provide', '不能提供', '无法提供', '不能透露', '无法透露']

export interface RawObservation {
  job: ProbeJob
  status: 'ok' | 'error' | 'cancelled'
  answer?: string
  elapsedMs?: number
  safeError?: string
}

export interface ScoringResult {
  status: Extract<RunStatus, 'completed' | 'incomplete' | 'failed'>
  summary: Record<string, unknown>
  observations: Record<string, unknown>[]
  storedObservations: StoredObservation[]
}

function normalizeNumber(value: string): string | null {
  if (value.length > 256) return null
  let text = value.trim()
  if (text.startsWith('```') && text.endsWith('```')) {
    const lines = text.split(/\r?\n/)
    if (lines.length >= 3) text = lines.slice(1, -1).join('\n').trim()
  }
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return null
  const sign = match[1] === '-' ? '-' : ''
  const integer = (match[2] ?? '0').replace(/^0+(?=\d)/, '')
  const fraction = (match[3] ?? '').replace(/0+$/, '')
  if (integer === '0' && !fraction) return '0'
  return `${sign}${integer}${fraction ? `.${fraction}` : ''}`
}

function matchesSignature(modelId: string, effort: string, value: string, seed: ScoringReleaseSeed): boolean {
  const signature = seed.signatures.find((item) => item.modelId === modelId && item.effort === effort)
  if (!signature) return false
  if (signature.matchRule === 'exact') return value === signature.expectedValue
  return value === signature.expectedValue || new RegExp(`^${signature.expectedValue}(?:\\.\\d+|\\d{2,})$`).test(value)
}

function classify(job: ProbeJob, raw: RawObservation, claimedModel: string, seed: ScoringReleaseSeed): StoredObservation {
  if (raw.status !== 'ok') {
    return {
      jobId: job.jobId, probeId: job.probeId, profile: job.profile, status: raw.status,
      normalizedValue: null, classification: null, hardAnomaly: false,
      elapsedMs: raw.elapsedMs ?? null, safeError: raw.safeError ?? null, metadata: { effort: job.effort },
    }
  }
  const answer = raw.answer ?? ''
  let normalizedValue: string | null = answer
  let classification = 'unsuccessful'
  let hardAnomaly = false
  const metadata: Record<string, unknown> = { effort: job.effort }

  if (job.probeId.startsWith('juice_') && job.probeId !== 'juice_coverage') {
    normalizedValue = normalizeNumber(answer)
    if (normalizedValue == null) {
      metadata['unsuccessful_reason'] = !answer.trim() || REFUSALS.some((item) => answer.toLowerCase().includes(item)) ? 'refusal_or_empty' : 'non_numeric'
    } else {
      const compatible = seed.models.map((item) => item.modelId).filter((model) => matchesSignature(model, job.effort, normalizedValue!, seed))
      if (compatible.includes(claimedModel)) {
        classification = 'current_success'
        metadata['shared_with_models'] = compatible.filter((model) => model !== claimedModel)
      } else if (compatible.length) {
        classification = 'mixed'
        hardAnomaly = true
        metadata['mixed_models'] = compatible
      } else {
        metadata['unsuccessful_reason'] = 'unknown_numeric'
      }
    }
  } else if (job.probeId.startsWith('output_')) {
    normalizedValue = null
    if (answer === job.expectedValue) {
      classification = 'current_success'
      normalizedValue = job.expectedValue
    }
    else if (/^40\d*$/.test(answer)) {
      classification = 'output_rewrite_40_prefix'
      hardAnomaly = true
      normalizedValue = answer.slice(0, 128)
    } else metadata['unsuccessful_reason'] = 'non_exact_non_40_output'
  } else if (job.probeId === 'juice_coverage') {
    normalizedValue = normalizeNumber(answer)
    if (normalizedValue === job.expectedValue) classification = 'explicit_value'
    else if (normalizedValue?.replace(/^[+-]/, '').startsWith('40')) {
      classification = 'explicit_hidden_override'
      hardAnomaly = true
    } else if (normalizedValue && ['low', 'medium', 'high', 'xhigh', 'max'].some((effort) => seed.models.some((model) => matchesSignature(model.modelId, effort, normalizedValue!, seed)))) {
      classification = 'known_juice_definition_ignored'
      hardAnomaly = true
    } else classification = normalizedValue == null ? 'unsuccessful' : 'other_numeric'
  } else if (job.probeId === 'b80_letter_count') {
    const numeric = normalizeNumber(answer)
    normalizedValue = numeric === '3' ? 'exact_3' : numeric == null ? '__INVALID_OUTPUT__' : 'other_integer'
    classification = 'category'
    metadata['category'] = normalizedValue
  } else {
    const normalized = answer.trim().replace(/^[`"'.,:;!?()[\]{}]+|[`"'.,:;!?()[\]{}]+$/g, '').toLowerCase().replace(/\s+/g, ' ')
    normalizedValue = /^[a-z][a-z .'-]*$/.test(normalized) && normalized.length <= 128 ? normalized : '__INVALID_OUTPUT__'
    classification = 'category'
    metadata['category'] = normalizedValue
  }

  return {
    jobId: job.jobId, probeId: job.probeId, profile: job.profile, status: 'ok', normalizedValue,
    classification, hardAnomaly, elapsedMs: raw.elapsedMs ?? null, safeError: null, metadata,
  }
}

function juiceSummary(run: RunRecord, rows: StoredObservation[]): Record<string, unknown> {
  const selections = run.config.probes.filter((item) => item.probe_id.startsWith('juice_') && item.probe_id !== 'juice_coverage')
  const perEffort: Record<string, Record<string, number>> = {}
  const mixedModels = new Set<string>()
  let mixed = false
  for (const selection of selections) {
    const effort = selection.probe_id.slice('juice_'.length)
    const matching = rows.filter((item) => item.probeId === selection.probe_id)
    const count = (name: string) => matching.filter((item) => item.classification === name).length
    const current = count('current_success')
    const mixedCount = count('mixed')
    const unsuccessful = count('unsuccessful')
    const valid = current + mixedCount + unsuccessful
    mixed ||= mixedCount > 0
    for (const row of matching) {
      const values = row.metadata['mixed_models']
      if (Array.isArray(values)) values.forEach((value) => mixedModels.add(String(value)))
    }
    perEffort[effort] = {
      attempted: matching.length,
      valid_completed: valid,
      current_success: current,
      mixed: mixedCount,
      unsuccessful,
      network_error: matching.filter((item) => item.status === 'error').length,
      minimum_valid: selection.requests,
    }
  }
  const efforts = Object.values(perEffort)
  const pass = efforts.length > 0 && !mixed && efforts.every((item) => item['current_success']! >= 1)
  const allUnsuccessful = efforts.length > 0 && !mixed && efforts.every((item) => item['valid_completed']! >= item['minimum_valid']! && item['current_success'] === 0 && item['unsuccessful'] === item['valid_completed'])
  const state = mixed ? 'juice_mixed' : pass ? 'juice_pass' : allUnsuccessful ? 'juice_all_unsuccessful' : 'data_insufficient'
  return {
    state, juice_mixed: mixed, juice_pass: pass, juice_all_unsuccessful: allUnsuccessful,
    data_insufficient: state === 'data_insufficient', mixed_models_observed: [...mixedModels].toSorted(), per_effort: perEffort,
  }
}

function normalizeFlatObject(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))))
}

function exactObject(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return normalizeFlatObject(left) === normalizeFlatObject(right)
}

function findCalibration(run: RunRecord, seed: ScoringReleaseSeed): { calibration: ScoringCalibrationSeed | null; required: Record<string, unknown> } {
  const required = Object.fromEntries(
    run.config.probes
      .filter((item) => ['rand_country', 'rand_bird', 'b80_letter_count'].includes(item.probe_id))
      .map((item) => [`${item.probe_id}|normal+no_history`, item.requests]),
  )
  const calibration = seed.calibrations.find((item) => item.runtimeName.startsWith('single:') && exactObject(item.requiredSamples, required)) ?? null
  return { calibration, required }
}

function safeLog(value: number): number {
  return Math.log(Math.max(value, 1e-300))
}

function softmax(scores: Record<string, number>): Record<string, number> {
  const maximum = Math.max(...Object.values(scores))
  const values = Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Math.exp(value - maximum)]))
  const total = Object.values(values).reduce((sum, value) => sum + value, 0)
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value / total]))
}

interface CellRuntime {
  key: string
  probeId: string
  counts: Record<string, number>
  sampleCount: number
  complete: boolean
  weight: number
  isolated: boolean
  distributions: Record<string, Record<string, number>>
  scores: Record<string, number>
}

function mixture(cells: CellRuntime[]): { proportions: Record<string, number>; mixture_gain: number; second_share: number } {
  const usable = cells.filter((cell) => cell.complete && !cell.isolated && cell.weight > 0)
  if (!usable.length) return { proportions: {}, mixture_gain: 0, second_share: 0 }
  const likelihood = (shares: number[]) => usable.reduce((total, cell) => {
    return total + Object.entries(cell.counts).reduce((sum, [category, count]) => {
      const probability = TARGET_MODELS.reduce((value, model, index) => value + shares[index]! * (cell.distributions[model]?.[category] ?? 0), 0)
      return sum + (cell.weight / Math.max(1, cell.sampleCount)) * count * safeLog(probability)
    }, 0)
  }, 0)
  let best = [1 / 3, 1 / 3, 1 / 3]
  let bestValue = Number.NEGATIVE_INFINITY
  for (const start of [[1 / 3, 1 / 3, 1 / 3], [0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]]) {
    let shares = [...start]
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const responsibilities = [0, 0, 0]
      let totalWeight = 0
      for (const cell of usable) {
        for (const [category, count] of Object.entries(cell.counts)) {
          const probabilities = TARGET_MODELS.map((model) => cell.distributions[model]?.[category] ?? 0)
          const denominator = shares.reduce((sum, share, index) => sum + share * probabilities[index]!, 0)
          if (denominator <= 0) continue
          const weight = (cell.weight / Math.max(1, cell.sampleCount)) * count
          totalWeight += weight
          for (let index = 0; index < 3; index += 1) responsibilities[index]! += weight * shares[index]! * probabilities[index]! / denominator
        }
      }
      if (totalWeight <= 0) break
      const updated = responsibilities.map((value) => value / totalWeight)
      if (Math.max(...updated.map((value, index) => Math.abs(value - shares[index]!))) < 1e-10) {
        shares = updated
        break
      }
      shares = updated
    }
    const value = likelihood(shares)
    if (value > bestValue) { best = shares; bestValue = value }
  }
  const bestPure = Math.max(...TARGET_MODELS.map((_model, target) => likelihood(TARGET_MODELS.map((_item, index) => index === target ? 1 : 0))))
  const ordered = [...best].toSorted((a, b) => b - a)
  return {
    proportions: Object.fromEntries(TARGET_MODELS.map((model, index) => [model, best[index]!])),
    mixture_gain: Math.max(0, bestValue - bestPure),
    second_share: ordered[1] ?? 0,
  }
}

function probabilitySummary(run: RunRecord, rows: StoredObservation[], seed: ScoringReleaseSeed): Record<string, unknown> {
  const enabled = run.config.probes.some((item) => ['rand_country', 'rand_bird', 'b80_letter_count'].includes(item.probe_id))
  if (!enabled) return { enabled: false, probability_pass: false, evidence_insufficient: false }
  const { calibration, required } = findCalibration(run, seed)
  const reasons: string[] = []
  if (!calibration) reasons.push('no_exact_runtime_calibration')
  else if (!calibration.formalEligible) reasons.push('baseline_calibration_gate_failed')
  const cells: CellRuntime[] = []
  for (const [key, rawRequired] of Object.entries(required)) {
    const requiredCount = Number(rawRequired)
    const seedCell: ScoringCellSeed | undefined = seed.cells.find((item) => `${item.probeId}|${item.profile}` === key)
    if (!seedCell) { reasons.push(`baseline_cell_missing:${key}`); continue }
    const fitted = seedCell.fittedParameters
    const categories = Array.isArray(fitted['categories']) ? fitted['categories'].map(String) : []
    const distributions = fitted['used_distributions'] as Record<string, Record<string, number>>
    const cellRows = rows.filter((item) => `${item.probeId}|${item.profile}` === key && item.classification === 'category')
    const counts = Object.fromEntries(categories.map((category) => [category, 0])) as Record<string, number>
    for (const row of cellRows) {
      const category = categories.includes(row.normalizedValue ?? '') ? row.normalizedValue! : '__OTHER__'
      counts[category] = (counts[category] ?? 0) + 1
    }
    const sampleCount = Object.values(counts).reduce((sum, value) => sum + value, 0)
    if (sampleCount < requiredCount) reasons.push(`candidate_samples_incomplete:${key}`)
    const scores = Object.fromEntries(TARGET_MODELS.map((model) => [
      model,
      Object.entries(counts).reduce((sum, [category, count]) => sum + count * safeLog(distributions[model]?.[category] ?? 0), 0) / Math.max(1, sampleCount),
    ]))
    const threshold = Number(calibration?.oodThresholds[key] ?? Number.NEGATIVE_INFINITY)
    const isolated = sampleCount >= requiredCount && Math.max(...Object.values(scores)) < threshold
    cells.push({ key, probeId: seedCell.probeId, counts, sampleCount, complete: sampleCount >= requiredCount, weight: Number(fitted['weight'] ?? 0), isolated, distributions, scores })
  }
  if (cells.length && cells.every((cell) => cell.isolated)) reasons.push('all_formal_families_ood')
  const totalScores = Object.fromEntries(TARGET_MODELS.map((model) => [model, safeLog(1 / 3)])) as Record<string, number>
  for (const probeId of new Set(cells.filter((cell) => !cell.isolated).map((cell) => cell.probeId))) {
    const family = cells.filter((cell) => cell.probeId === probeId && !cell.isolated)
    const weightSum = family.reduce((sum, cell) => sum + cell.weight, 0)
    if (weightSum <= 0) continue
    const familyWeight = Math.min(1, Math.max(...family.map((cell) => cell.weight)))
    for (const model of TARGET_MODELS) {
      totalScores[model] = totalScores[model]! + familyWeight * family.reduce((sum, cell) => sum + cell.weight * cell.scores[model]!, 0) / weightSum
    }
  }
  const temperature = Number(calibration?.thresholds['temperature'] ?? 1)
  const probabilities = softmax(Object.fromEntries(TARGET_MODELS.map((model) => [model, totalScores[model]! / temperature])))
  const ordered = [...TARGET_MODELS].toSorted((a, b) => totalScores[b]! - totalScores[a]!)
  const winner = ordered[0]!
  const margin = totalScores[winner]! - totalScores[ordered[1]!]!
  const fittedMixture = mixture(cells)
  const formalReady = reasons.length === 0
  const alertMargin = Number(calibration?.thresholds['alert_margin'] ?? Number.POSITIVE_INFINITY)
  const passMargin = Number(calibration?.thresholds['pass_margin'] ?? Number.POSITIVE_INFINITY)
  const mixtureThreshold = Number(calibration?.thresholds['mixture_gain_threshold'] ?? Number.POSITIVE_INFINITY)
  const pureAlert = formalReady && winner !== run.model && margin >= alertMargin
  const mixtureAlert = formalReady && fittedMixture.mixture_gain >= mixtureThreshold && fittedMixture.second_share >= 0.1
  return {
    enabled: true, formal_eligible: formalReady, winner, score_margin: margin,
    conditional_relative_probability: probabilities, pure_scores: totalScores,
    pure_model_alert: pureAlert, mixture_alert: mixtureAlert,
    probability_pass: formalReady && winner === run.model && margin >= passMargin && !mixtureAlert,
    evidence_insufficient: !formalReady, evidence_insufficient_reasons: reasons,
    mixture: fittedMixture,
  }
}

export function scoreRun(run: RunRecord, rawRows: RawObservation[], seed: ScoringReleaseSeed): ScoringResult {
  const rows = rawRows.map((raw) => classify(raw.job, raw, run.model, seed))
  const juice = juiceSummary(run, rows)
  const outputHard = rows.some((item) => item.probeId.startsWith('output_') && item.hardAnomaly)
  const coverageHard = rows.some((item) => item.probeId === 'juice_coverage' && item.hardAnomaly)
  const probability = probabilitySummary(run, rows, seed)
  let verdict: string | null
  if (juice['juice_all_unsuccessful']) verdict = '可能非GPT'
  else if (juice['juice_mixed'] || outputHard || coverageHard) verdict = 'Juice混用'
  else if (!juice['juice_pass']) verdict = null
  else if (probability['enabled'] && (probability['pure_model_alert'] || probability['mixture_alert'])) verdict = '仅概率探针混用'
  else if (!probability['enabled'] || probability['probability_pass']) verdict = '通过'
  else verdict = 'Juice通过但概率探针证据不足'

  const errors = rows.filter((item) => item.status === 'error').length
  const status = errors === rows.length ? 'failed' : errors > 0 ? 'incomplete' : 'completed'
  return {
    status,
    summary: {
      overall_verdict: verdict,
      verdict_available: verdict != null,
      operational_status: status,
      juice_summary: juice,
      output_integrity: { hard_anomaly: outputHard },
      coverage: { hard_anomaly: coverageHard },
      probability,
      completed_requests: rows.length - errors,
      failed_requests: errors,
    },
    observations: rows.map((item) => ({
      job_id: item.jobId,
      probe_id: item.probeId,
      profile: item.profile,
      status: item.status,
      normalized_value: item.normalizedValue,
      classification: item.classification,
      hard_anomaly: item.hardAnomaly,
      elapsed_ms: item.elapsedMs,
      safe_error: item.safeError,
      metadata: item.metadata,
    })),
    storedObservations: rows,
  }
}
