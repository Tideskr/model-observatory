import type { RunStatus } from '../contracts/common.js'
import type { RunRecord, StoredObservation } from '../store/run-store.js'
import type { ProbeJob } from '../executor/job-plan.js'
import { empiricalFingerprintReliability } from './fingerprint-reliability.js'
import type { ScoringCalibrationSeed, ScoringCellSeed, ScoringReleaseSeed, VerdictRuleSeed } from './types.js'

const TARGET_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const
const MODEL_LABELS: Record<string, string> = { 'gpt-5.6-sol': 'Sol', 'gpt-5.6-terra': 'Terra', 'gpt-5.6-luna': 'Luna' }
const REFUSALS = ['cannot provide', "can't provide", 'unable to provide', '不能提供', '无法提供', '不能透露', '无法透露']

export interface RawObservation {
  job: ProbeJob
  status: 'ok' | 'error' | 'cancelled'
  answer?: string
  elapsedMs?: number
  safeError?: string
  safeMessage?: string
  attempts?: number
  statusCode?: number | null
  retryable?: boolean
  inputTokens?: number
  outputTokens?: number
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

export function scoreObservation(run: RunRecord, raw: RawObservation, seed: ScoringReleaseSeed): StoredObservation {
  const job = raw.job
  const transportMetadata = {
    effort: job.effort,
    attempts_sent: raw.attempts ?? 1,
    http_status: raw.statusCode ?? null,
    retryable: raw.retryable ?? false,
    safe_message: raw.safeMessage ?? null,
    input_tokens: raw.inputTokens ?? null,
    output_tokens: raw.outputTokens ?? null,
  }
  if (raw.status !== 'ok') {
    return {
      jobId: job.jobId, probeId: job.probeId, profile: job.profile, status: raw.status,
      normalizedValue: null, classification: null, hardAnomaly: false,
      elapsedMs: raw.elapsedMs ?? null, safeError: raw.safeError ?? null, metadata: transportMetadata,
    }
  }
  const answer = raw.answer ?? ''
  let normalizedValue: string | null = answer
  let classification = 'unsuccessful'
  let hardAnomaly = false
  const metadata: Record<string, unknown> = transportMetadata

  if (job.probeId.startsWith('juice_') && job.probeId !== 'juice_coverage') {
    normalizedValue = normalizeNumber(answer)
    if (normalizedValue == null) {
      metadata['unsuccessful_reason'] = !answer.trim() || REFUSALS.some((item) => answer.toLowerCase().includes(item)) ? 'refusal_or_empty' : 'non_numeric'
    } else {
      const compatible = seed.models.map((item) => item.modelId).filter((model) => matchesSignature(model, job.effort, normalizedValue!, seed))
      if (compatible.includes(run.model)) {
        classification = 'current_success'
        metadata['shared_with_models'] = compatible.filter((model) => model !== run.model)
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
  const total = (name: string) => efforts.reduce((sum, item) => sum + (item[name] ?? 0), 0)
  const pass = efforts.length > 0 && !mixed && efforts.every((item) => item['current_success']! >= 1)
  const allUnsuccessful = efforts.length > 0 && !mixed && efforts.every((item) => item['valid_completed']! >= item['minimum_valid']! && item['current_success'] === 0 && item['unsuccessful'] === item['valid_completed'])
  const state = mixed ? 'juice_mixed' : pass ? 'juice_pass' : allUnsuccessful ? 'juice_all_unsuccessful' : 'data_insufficient'
  return {
    state, juice_mixed: mixed, juice_pass: pass, juice_all_unsuccessful: allUnsuccessful,
    data_insufficient: state === 'data_insufficient', mixed_models_observed: [...mixedModels].toSorted(),
    current_success: total('current_success'), mixed: total('mixed'), unsuccessful: total('unsuccessful'),
    network_error: total('network_error'), per_effort: perEffort,
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

function probabilitySummary(run: RunRecord, rows: StoredObservation[], seed: ScoringReleaseSeed): Record<string, unknown> {
  const enabled = run.config.probes.some((item) => ['rand_country', 'rand_bird', 'b80_letter_count'].includes(item.probe_id))
  if (!enabled) return {
    enabled: false,
    fingerprint_status: 'unclear',
    fingerprint_model: null,
    winner: null,
    fingerprint_match: {},
    fingerprint_match_meaning: 'relative_likelihood_not_calibrated_probability',
    empirical_reliability: empiricalFingerprintReliability(seed, null, null, false),
    probability_pass: false,
    evidence_insufficient: false,
    fingerprint_unclear_reasons: ['builtin_fingerprint_not_enabled'],
  }
  const { calibration, required } = findCalibration(run, seed)
  const reasons: string[] = []
  if (!calibration) reasons.push('no_exact_runtime_contract')
  else if (!calibration.formalEligible) reasons.push('runtime_reference_only')
  const cells: Array<{ key: string; probeId: string; sampleCount: number; weight: number; scores: Record<string, number> }> = []
  for (const [key, rawRequired] of Object.entries(required)) {
    const requiredCount = Number(rawRequired)
    const seedCell: ScoringCellSeed | undefined = seed.cells.find((item) => `${item.probeId}|${item.profile}` === key)
    if (!seedCell) { reasons.push('baseline_cells_missing'); continue }
    const fitted = seedCell.fittedParameters
    const categories = Array.isArray(fitted['categories']) ? fitted['categories'].map(String) : []
    const distributions = fitted['model_distributions'] as Record<string, Record<string, number>>
    const cellRows = rows.filter((item) => `${item.probeId}|${item.profile}` === key && item.classification === 'category')
    const counts = Object.fromEntries(categories.map((category) => [category, 0])) as Record<string, number>
    for (const row of cellRows) {
      const category = categories.includes(row.normalizedValue ?? '') ? row.normalizedValue! : '__OTHER__'
      counts[category] = (counts[category] ?? 0) + 1
    }
    const sampleCount = Object.values(counts).reduce((sum, value) => sum + value, 0)
    const minimumCompleted = Math.ceil(requiredCount * 0.9)
    if (sampleCount < minimumCompleted) reasons.push('candidate_samples_incomplete')
    const scores = Object.fromEntries(TARGET_MODELS.map((model) => [
      model,
      Object.entries(counts).reduce((sum, [category, count]) => sum + count * safeLog(distributions[model]?.[category] ?? 0), 0) / Math.max(1, sampleCount),
    ]))
    cells.push({ key, probeId: seedCell.probeId, sampleCount, weight: Number(fitted['weight'] ?? 0), scores })
  }
  const totalScores = Object.fromEntries(TARGET_MODELS.map((model) => [model, 0])) as Record<string, number>
  let activeFamilies = 0
  for (const probeId of new Set(cells.filter((cell) => cell.sampleCount > 0 && cell.weight > 0).map((cell) => cell.probeId))) {
    const family = cells.filter((cell) => cell.probeId === probeId && cell.sampleCount > 0 && cell.weight > 0)
    const weightSum = family.reduce((sum, cell) => sum + cell.weight, 0)
    if (weightSum <= 0) continue
    activeFamilies += 1
    const familyWeight = Math.min(1, Math.max(...family.map((cell) => cell.weight)))
    for (const model of TARGET_MODELS) {
      totalScores[model] = totalScores[model]! + familyWeight * family.reduce((sum, cell) => sum + cell.weight * cell.scores[model]!, 0) / weightSum
    }
  }
  if (!activeFamilies) reasons.push('no_weighted_fingerprint_family')
  const probabilities = activeFamilies
    ? softmax(totalScores)
    : Object.fromEntries(TARGET_MODELS.map((model) => [model, 1 / TARGET_MODELS.length]))
  const ordered = [...TARGET_MODELS].toSorted((a, b) => probabilities[b]! - probabilities[a]!)
  const winner = activeFamilies > 0 ? ordered[0]! : null
  const thresholds = (calibration?.thresholds['strong_match'] ?? {}) as Record<string, number>
  const formalReady = reasons.length === 0 && activeFamilies > 0
  const winners = TARGET_MODELS.filter((model) => formalReady && probabilities[model]! > Number(thresholds[model] ?? 1))
  const fingerprintStatus = winners.length === 1 ? 'strong_match' : 'unclear'
  const fingerprintModel = winners.length === 1 ? winners[0]! : null
  if (formalReady && winners.length === 0) reasons.push('no_model_reached_strong_match_threshold')
  if (winners.length > 1) reasons.push('multiple_models_reached_threshold')
  const tier = typeof calibration?.details['decision_level'] === 'string' ? calibration.details['decision_level'] : null
  return {
    enabled: true,
    formal_eligible: formalReady,
    winner,
    fingerprint_status: fingerprintStatus,
    fingerprint_model: fingerprintModel,
    fingerprint_match: probabilities,
    fingerprint_match_meaning: 'relative_likelihood_not_calibrated_probability',
    fingerprint_thresholds: thresholds,
    fingerprint_official_eligible: formalReady,
    fingerprint_unclear_reasons: [...new Set(reasons)],
    empirical_reliability: empiricalFingerprintReliability(seed, tier, fingerprintModel, fingerprintStatus === 'strong_match'),
    conditional_relative_probability: probabilities,
    pure_scores: totalScores,
    pure_model_alert: fingerprintModel != null && fingerprintModel !== run.model,
    mixture_alert: false,
    probability_pass: fingerprintModel === run.model,
    evidence_insufficient: !formalReady,
    evidence_insufficient_reasons: [...new Set(reasons)],
  }
}

const FALLBACK_VERDICT_RULE: VerdictRuleSeed = {
  priority: Number.MAX_SAFE_INTEGER,
  ruleId: 'runtime-fallback',
  title: null,
  predicateId: 'fallback',
  severe: false,
}

function matchesVerdictRule(
  rule: VerdictRuleSeed,
  juice: Record<string, unknown>,
  outputHard: boolean,
  coverageHard: boolean,
  probability: Record<string, unknown>,
): boolean {
  switch (rule.predicateId) {
    case 'juice_all_unsuccessful':
      return juice['juice_all_unsuccessful'] === true
    case 'juice_mixed_or_deterministic_anomaly':
      return juice['juice_mixed'] === true || outputHard || coverageHard
    case 'juice_not_passed':
      return juice['juice_pass'] !== true
    case 'juice_pass_and_probability_alert':
      return juice['juice_pass'] === true && probability['enabled'] === true && (
        probability['pure_model_alert'] === true || probability['mixture_alert'] === true
      )
    case 'juice_pass_and_probability_pass_or_disabled':
      return juice['juice_pass'] === true && (
        probability['enabled'] !== true || probability['probability_pass'] === true
      )
    case 'fallback':
      return true
    default:
      return false
  }
}

function renderVerdict(rule: VerdictRuleSeed, fingerprintText: string): string {
  switch (rule.predicateId) {
    case 'juice_all_unsuccessful': return '可能非GPT'
    case 'juice_mixed_or_deterministic_anomaly': return `Juice与申报型号不一致；${fingerprintText}`
    case 'juice_not_passed': return `Juice证据不足；${fingerprintText}`
    case 'juice_pass_and_probability_alert': return `仅概率探针混用；${fingerprintText}`
    case 'juice_pass_and_probability_pass_or_disabled': return `Juice通过；${fingerprintText}`
    case 'fallback': return `Juice通过但概率探针证据不足；${fingerprintText}`
    default: return `${rule.title ?? '评分规则未定义'}；${fingerprintText}`
  }
}

export function scoreStoredRun(run: RunRecord, rows: StoredObservation[], seed: ScoringReleaseSeed): ScoringResult {
  const juice = juiceSummary(run, rows)
  const outputHard = rows.some((item) => item.probeId.startsWith('output_') && item.hardAnomaly)
  const coverageHard = rows.some((item) => item.probeId === 'juice_coverage' && item.hardAnomaly)
  const probability = probabilitySummary(run, rows, seed)
  const fingerprintStrong = probability['fingerprint_status'] === 'strong_match'
  const fingerprintModel = typeof probability['fingerprint_model'] === 'string' ? probability['fingerprint_model'] : null
  const fingerprintText = fingerprintStrong ? `指纹强烈指向 ${MODEL_LABELS[fingerprintModel ?? ''] ?? fingerprintModel}` : '指纹证据不明确'
  const rules = [...(seed.verdictRules.length ? seed.verdictRules : [FALLBACK_VERDICT_RULE])]
    .toSorted((left, right) => left.priority - right.priority)
  const verdictRule = rules.find((rule) => matchesVerdictRule(rule, juice, outputHard, coverageHard, probability)) ?? FALLBACK_VERDICT_RULE
  const verdict = renderVerdict(verdictRule, fingerprintText)

  const successful = rows.filter((item) => item.status === 'ok').length
  const errors = rows.filter((item) => item.status === 'error').length
  const cancelled = rows.filter((item) => item.status === 'cancelled').length
  const status = errors === rows.length ? 'failed' : errors > 0 ? 'incomplete' : 'completed'
  const attempts = rows.reduce((total, item) => total + Number(item.metadata['attempts_sent'] ?? 1), 0)
  const retries = Math.max(0, attempts - rows.length)
  const profileSummary: Record<string, { logical_tasks: number; successful: number; final_errors: number; cancelled: number }> = {}
  for (const item of rows) {
    const profile = profileSummary[item.profile] ?? { logical_tasks: 0, successful: 0, final_errors: 0, cancelled: 0 }
    profile.logical_tasks += 1
    if (item.status === 'ok') profile.successful += 1
    else if (item.status === 'error') profile.final_errors += 1
    else profile.cancelled += 1
    profileSummary[item.profile] = profile
  }
  const errorGroups = new Map<string, {
    code: string; message: string | null; http_status: number | null; retryable: boolean; count: number; attempts: number
  }>()
  for (const item of rows.filter((row) => row.status === 'error')) {
    const code = item.safeError ?? 'unknown_error'
    const message = typeof item.metadata['safe_message'] === 'string' ? item.metadata['safe_message'] : null
    const httpStatus = typeof item.metadata['http_status'] === 'number' ? item.metadata['http_status'] : null
    const retryable = item.metadata['retryable'] === true
    const key = JSON.stringify([code, message, httpStatus, retryable])
    const group = errorGroups.get(key) ?? { code, message, http_status: httpStatus, retryable, count: 0, attempts: 0 }
    group.count += 1
    group.attempts += Number(item.metadata['attempts_sent'] ?? 1)
    errorGroups.set(key, group)
  }
  return {
    status,
    summary: {
      overall_verdict: verdict,
      title_cn: verdict,
      verdict_rule_id: verdictRule.ruleId,
      verdict_rule_title: verdictRule.title,
      verdict_rule_severe: verdictRule.severe,
      subtitle_cn: status === 'completed' ? '检测已完成，以下结论只适用于本次目标、配置和评分版本。' : '部分请求失败，请结合网络错误与逐请求观测阅读结论。',
      verdict_available: true,
      operational_status: status,
      juice_summary: juice,
      output_integrity: { hard_anomaly: outputHard },
      coverage: { hard_anomaly: coverageHard },
      probability,
      fingerprint_summary: probability,
      network_summary: {
        logical_tasks: rows.length,
        logical_completed: rows.length,
        successful,
        final_errors: errors,
        cancelled,
        http_attempts: attempts,
        retries,
        in_flight: 0,
      },
      profile_summary: profileSummary,
      error_summary: [...errorGroups.values()],
      completed_requests: rows.length,
      successful_requests: successful,
      failed_requests: errors,
      cancelled_requests: cancelled,
      http_attempts: attempts,
      retries,
      limitations: [
        '该结论只适用于本次目标、配置和评分版本。',
        '行为指纹属于统计证据，不是底层模型路由的密码学证明。',
      ],
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
      attempts_sent: Number(item.metadata['attempts_sent'] ?? 1),
      http_status: item.metadata['http_status'] ?? null,
      retryable: item.metadata['retryable'] ?? false,
      safe_message: item.metadata['safe_message'] ?? null,
      metadata: item.metadata,
    })),
    storedObservations: rows,
  }
}

export function scoreRun(run: RunRecord, rawRows: RawObservation[], seed: ScoringReleaseSeed): ScoringResult {
  return scoreStoredRun(run, rawRows.map((raw) => scoreObservation(run, raw, seed)), seed)
}
