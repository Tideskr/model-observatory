import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  ScoringCalibrationSeed,
  ScoringCellSeed,
  ScoringProbeSeed,
  ScoringReleaseSeed,
  ScoringSignatureSeed,
  ScoringTemplateSeed,
} from './types.js'

type JsonObject = Record<string, unknown>

const TRUSTED_CATALOG_SOURCE_SHA256 = '8cf89f903d467cc5fb0c461ec5154347fcb59e5aac6b036e79cf9bdd8b204eb8'
const TRUSTED_BASELINE_SOURCE_SHA256 = 'a1de0b4cce26a6df3dfc59907a7b5043460f9cde3614d38d0919e98fd4ba2100'
const TRUSTED_BASELINE_CONTENT_SHA256 = 'dd692466ea601d99b737edae66a35941f236d5e7426244f2c04e43f314f43851'

const signatureValues: Record<string, Record<string, string>> = {
  'gpt-5.6-sol': { low: '8', medium: '16', high: '40', xhigh: '128', max: '960' },
  'gpt-5.6-terra': { low: '12', medium: '16', high: '32', xhigh: '84', max: '960' },
  'gpt-5.6-luna': { low: '8', medium: '16', high: '48', xhigh: '128', max: '768' },
  'gpt-5.5': { low: '12', medium: '24', high: '96', xhigh: '768' },
  'gpt-5.4': { low: '12', medium: '20', high: '96', xhigh: '512' },
  'gpt-5.4-mini': { low: '8', medium: '24', high: '64', xhigh: '768' },
}

function object(value: unknown, label: string): JsonObject {
  if (value == null || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`)
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`)
  return value
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function trustedSourceHash(value: string): string {
  return sha256(value.replace(/\r\n/g, '\n'))
}

function parseJson(raw: string, label: string): JsonObject {
  try {
    return object(JSON.parse(raw), label)
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

function promptHash(prompt: string, expected: string, label: string): void {
  if (sha256(prompt) !== expected) throw new Error(`${label} prompt hash mismatch`)
}

function buildProbes(catalog: JsonObject, baseline: JsonObject): ScoringProbeSeed[] {
  const metadata = object(baseline['probe_metadata'], 'probe_metadata')
  const behavior = object(catalog['behavior_probes'], 'behavior_probes')
  const result: ScoringProbeSeed[] = []

  for (const [probeId, rawValue] of Object.entries(behavior)) {
    const value = object(rawValue, `behavior_probes.${probeId}`)
    const baselineValue = object(metadata[probeId], `probe_metadata.${probeId}`)
    const prompt = text(value['prompt'], `${probeId}.prompt`)
    const hash = text(value['prompt_sha256'], `${probeId}.prompt_sha256`)
    promptHash(prompt, hash, probeId)
    if (baselineValue['user_prompt_sha256'] !== hash) throw new Error(`${probeId} differs between catalog and baseline`)
    const normalizer = object(baselineValue['normalizer'], `${probeId}.normalizer`)
    const developerPrompt = String(baselineValue['developer_prompt'] ?? '')
    const developerPromptSha256 = text(baselineValue['developer_prompt_sha256'], `${probeId}.developer_prompt_sha256`)
    promptHash(developerPrompt, developerPromptSha256, `${probeId} developer`)
    result.push({
      probeId,
      category: 'distribution',
      prompt,
      promptSha256: hash,
      developerPrompt,
      developerPromptSha256,
      normalizerId: text(normalizer['id'], `${probeId}.normalizer.id`),
      normalizer,
      scoringKind: text(value['scoring_kind'], `${probeId}.scoring_kind`),
      promptRewriteAllowed: value['user_prompt_rewrite_allowed'] === true,
      metadata: { ...value, baseline: baselineValue },
    })
  }
  const templates = object(catalog['templates'], 'templates')
  const primaryTemplate = object(templates['public-01'], 'templates.public-01')
  const juicePrompt = text(primaryTemplate['prompt'], 'templates.public-01.prompt')
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    result.push({
      probeId: `juice_${effort}`,
      category: 'juice',
      prompt: juicePrompt,
      promptSha256: sha256(juicePrompt),
      developerPrompt: '',
      developerPromptSha256: sha256(''),
      normalizerId: 'integer',
      normalizer: { id: 'integer', parameters: {} },
      scoringKind: 'model_signature',
      promptRewriteAllowed: true,
      metadata: { effort, template_pool: effort, templates },
    })
  }

  for (const [probeId, expected] of [
    ['output_luna_48', '48'],
    ['output_terra_32', '32'],
  ] as const) {
    const prompt = `Reply with exactly the two ASCII digits ${expected}. Do not add any other text.`
    result.push({
      probeId,
      category: 'output_integrity',
      prompt,
      promptSha256: sha256(prompt),
      developerPrompt: '',
      developerPromptSha256: sha256(''),
      normalizerId: 'exact_trimmed',
      normalizer: { id: 'exact_trimmed', parameters: {} },
      scoringKind: 'exact_with_40_prefix_anomaly',
      promptRewriteAllowed: false,
      metadata: { expected, hard_anomaly_prefix: '40' },
    })
  }

  const coverage = object(catalog['coverage_probe'], 'coverage_probe')
  const messages = Array.isArray(coverage['messages']) ? coverage['messages'].map((item) => object(item, 'coverage message')) : []
  const developerPrompt = String(messages.find((item) => item['role'] === 'developer')?.['content'] ?? '')
  const userPrompt = String(messages.find((item) => item['role'] === 'user')?.['content'] ?? '')
  result.push({
    probeId: 'juice_coverage',
    category: 'coverage',
    prompt: userPrompt,
    promptSha256: sha256(userPrompt),
    developerPrompt,
    developerPromptSha256: sha256(developerPrompt),
    normalizerId: 'integer',
    normalizer: { id: 'integer', parameters: {} },
    scoringKind: 'synthetic_value_with_known_juice_anomaly',
    promptRewriteAllowed: false,
    metadata: { ...coverage, legacy_probe_id: coverage['probe_id'] },
  })
  return result
}

function buildTemplates(catalog: JsonObject): ScoringTemplateSeed[] {
  const templates = object(catalog['templates'], 'templates')
  const pools = object(catalog['pools'], 'pools')
  return Object.entries(pools).flatMap(([effort, templateIds]) =>
    (Array.isArray(templateIds) ? templateIds : []).map((rawTemplateId) => {
      const templateId = String(rawTemplateId)
      const value = object(templates[templateId], `templates.${templateId}`)
      const prompt = text(value['prompt'], `${templateId}.prompt`)
      return {
        probeId: `juice_${effort}`,
        templateId,
        prompt,
        promptSha256: sha256(prompt),
        metadata: value,
      }
    }),
  )
}

function buildSignatures(): ScoringSignatureSeed[] {
  return Object.entries(signatureValues).flatMap(([modelId, values]) =>
    Object.entries(values).map(([effort, expectedValue]) => ({
      modelId,
      effort,
      expectedValue,
      matchRule:
        modelId === 'gpt-5.6-sol' && ['low', 'medium', 'high'].includes(effort)
          ? ('exact_or_decimal_or_long_prefix' as const)
          : ('exact' as const),
    })),
  )
}

function buildCells(baseline: JsonObject): ScoringCellSeed[] {
  const rawCounts = object(baseline['raw_counts'], 'raw_counts')
  const fitted = object(baseline['cells'], 'cells')
  const quality = object(baseline['cells_quality'], 'cells_quality')
  return Object.entries(fitted).map(([key, rawFitted]) => {
    const [probeId, profile] = key.split('|')
    if (!probeId || !profile) throw new Error(`invalid cell key ${key}`)
    const probe = object(rawCounts[probeId], `raw_counts.${probeId}`)
    const profiles = object(probe['profiles'], `raw_counts.${probeId}.profiles`)
    const fittedValue = object(rawFitted, `cells.${key}`)
    return {
      probeId,
      profile,
      categories: Array.isArray(fittedValue['categories']) ? fittedValue['categories'] : [],
      rawCounts: object(profiles[profile], `raw_counts.${probeId}.profiles.${profile}`),
      fittedParameters: fittedValue,
      quality: object(quality[key], `cells_quality.${key}`),
    }
  })
}

function buildCalibrations(baseline: JsonObject): ScoringCalibrationSeed[] {
  return Object.entries(object(baseline['calibrations'], 'calibrations')).map(([signature, rawValue]) => {
    const value = object(rawValue, `calibrations.${signature}`)
    if (text(value['runtime_signature'], `${signature}.runtime_signature`) !== signature) {
      throw new Error(`${signature} calibration runtime signature mismatch`)
    }
    const thresholds = {
      tau: value['tau'],
      pass_margin: value['pass_margin'],
      alert_margin: value['alert_margin'],
      mixture_gain_threshold: value['mixture_gain_threshold'],
      temperature: value['temperature'],
    }
    return {
      runtimeSignature: signature,
      runtimeName: text(value['runtime_name'], `${signature}.runtime_name`),
      formalEligible: value['formal_eligible'] === true,
      requiredSamples: object(value['required_samples'], `${signature}.required_samples`),
      exactContracts: object(value['exact_contracts'], `${signature}.exact_contracts`),
      thresholds,
      oodThresholds: object(value['ood_thresholds'], `${signature}.ood_thresholds`),
      details: value,
    }
  })
}

export async function importLegacyScoringRelease(
  catalogPath: string,
  baselinePath: string,
): Promise<ScoringReleaseSeed> {
  const [catalogRaw, baselineRaw] = await Promise.all([
    readFile(catalogPath, 'utf8'),
    readFile(baselinePath, 'utf8'),
  ])
  if (trustedSourceHash(catalogRaw) !== TRUSTED_CATALOG_SOURCE_SHA256) throw new Error('Legacy runtime catalog source hash mismatch')
  if (trustedSourceHash(baselineRaw) !== TRUSTED_BASELINE_SOURCE_SHA256) throw new Error('Legacy baseline source hash mismatch')
  const catalog = parseJson(catalogRaw, 'runtime catalog')
  const baseline = parseJson(baselineRaw, 'trusted likelihood baseline')
  if (catalog['schema_version'] !== 1) throw new Error('unsupported Legacy catalog schema')
  if (baseline['schema_version'] !== 2) throw new Error('unsupported Legacy baseline schema')
  if (baseline['content_sha256'] !== TRUSTED_BASELINE_CONTENT_SHA256) throw new Error('Legacy baseline content hash mismatch')
  const models = Array.isArray(baseline['models']) ? baseline['models'].map(String) : []
  if (models.join(',') !== 'gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna') {
    throw new Error('unexpected target model set in Legacy baseline')
  }

  return {
    id: text(baseline['baseline_id'], 'baseline_id'),
    schemaVersion: Number(baseline['schema_version']),
    scoringVersion: text(baseline['scoring_version'], 'scoring_version'),
    contentSha256: text(baseline['content_sha256'], 'content_sha256'),
    sourceSha256: sha256(baselineRaw),
    formalEligible: baseline['formal_eligible'] === true,
    thresholdPolicy: object(baseline['threshold_policy'], 'threshold_policy'),
    artifact: baseline,
    models: Object.keys(signatureValues).map((modelId) => ({
      modelId,
      modelKind: models.includes(modelId) ? 'target' : 'legacy',
    })),
    probes: buildProbes(catalog, baseline),
    templates: buildTemplates(catalog),
    signatures: buildSignatures(),
    cells: buildCells(baseline),
    calibrations: buildCalibrations(baseline),
    verdictRules: [
      { priority: 10, ruleId: 'all_juice_unsuccessful', title: '可能非GPT', predicateId: 'juice_all_unsuccessful', severe: true },
      { priority: 20, ruleId: 'deterministic_anomaly', title: 'Juice混用', predicateId: 'juice_mixed_or_deterministic_anomaly', severe: true },
      { priority: 30, ruleId: 'juice_incomplete', title: null, predicateId: 'juice_not_passed', severe: false },
      { priority: 40, ruleId: 'probability_alert', title: '仅概率探针混用', predicateId: 'juice_pass_and_probability_alert', severe: true },
      { priority: 50, ruleId: 'pass', title: '通过', predicateId: 'juice_pass_and_probability_pass_or_disabled', severe: false },
      { priority: 60, ruleId: 'probability_insufficient', title: 'Juice通过但概率探针证据不足', predicateId: 'fallback', severe: false },
    ],
  }
}
