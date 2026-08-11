import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type {
  ScoringCalibrationSeed,
  ScoringCellSeed,
  ScoringProbeSeed,
  ScoringReleaseSeed,
  ScoringSignatureSeed,
  ScoringTemplateSeed,
  VerdictRuleSeed,
} from './types.js'

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (value == null || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`)
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseJson(raw: string, label: string): JsonObject {
  try {
    return object(JSON.parse(raw), label)
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

function verifyArtifact(root: string, manifest: JsonObject, name: string): Promise<{ raw: string; value: JsonObject }> {
  const descriptor = object(object(manifest['artifacts'], 'manifest.artifacts')[name], `manifest.artifacts.${name}`)
  const path = resolve(root, text(descriptor['file'], `${name}.file`))
  return readFile(path, 'utf8').then((raw) => {
    if (sha256(raw) !== text(descriptor['sha256'], `${name}.sha256`)) throw new Error(`${name} source hash mismatch`)
    return { raw, value: parseJson(raw, name) }
  })
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
  for (const [probeId, expected] of [['output_luna_48', '48'], ['output_terra_32', '32']] as const) {
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
  return Object.entries(object(catalog['pools'], 'pools')).flatMap(([effort, templateIds]) =>
    (Array.isArray(templateIds) ? templateIds : []).map((rawTemplateId) => {
      const templateId = String(rawTemplateId)
      const value = object(templates[templateId], `templates.${templateId}`)
      const prompt = text(value['prompt'], `${templateId}.prompt`)
      return { probeId: `juice_${effort}`, templateId, prompt, promptSha256: sha256(prompt), metadata: value }
    }),
  )
}

function buildSignatures(manifest: JsonObject): ScoringSignatureSeed[] {
  return Object.entries(object(manifest['signatures'], 'manifest.signatures')).flatMap(([modelId, rawEfforts]) =>
    Object.entries(object(rawEfforts, `signatures.${modelId}`)).map(([effort, rawSignature]) => {
      const signature = object(rawSignature, `signatures.${modelId}.${effort}`)
      const matchRule = text(signature['match_rule'], `${modelId}.${effort}.match_rule`)
      if (!['exact', 'exact_or_decimal_or_long_prefix'].includes(matchRule)) throw new Error(`unsupported match rule: ${matchRule}`)
      return { modelId, effort, expectedValue: text(signature['value'], `${modelId}.${effort}.value`), matchRule: matchRule as ScoringSignatureSeed['matchRule'] }
    }),
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

function buildCalibrations(manifest: JsonObject, baseline: JsonObject): ScoringCalibrationSeed[] {
  const thresholds = object(manifest['formal_thresholds'], 'manifest.formal_thresholds')
  return Object.entries(object(baseline['runtime_contracts'], 'runtime_contracts')).map(([signature, rawContract]) => {
    const contract = object(rawContract, `runtime_contracts.${signature}`)
    if (contract['runtime_signature'] !== signature) throw new Error(`${signature} runtime signature mismatch`)
    const decisionLevel = text(contract['decision_level'], `${signature}.decision_level`)
    return {
      runtimeSignature: signature,
      runtimeName: text(contract['runtime_name'], `${signature}.runtime_name`),
      formalEligible: contract['formal_eligible'] === true,
      requiredSamples: object(contract['required_samples'], `${signature}.required_samples`),
      exactContracts: object(contract['exact_contracts'], `${signature}.exact_contracts`),
      thresholds: { strong_match: object(thresholds[decisionLevel], `formal_thresholds.${decisionLevel}`) },
      oodThresholds: {},
      details: contract,
    }
  })
}

function buildVerdictRules(manifest: JsonObject): VerdictRuleSeed[] {
  const rows = Array.isArray(manifest['verdict_rules']) ? manifest['verdict_rules'] : []
  return rows.map((raw) => {
    const value = object(raw, 'verdict rule')
    return {
      priority: Number(value['priority']),
      ruleId: text(value['rule_id'], 'verdict rule id'),
      title: value['title'] == null ? null : String(value['title']),
      predicateId: text(value['predicate_id'], 'verdict predicate id'),
      severe: value['severe'] === true,
    }
  })
}

function validateFingerprintCalibration(calibration: JsonObject, manifest: JsonObject, baseline: JsonObject): JsonObject {
  if (calibration['schema_version'] !== 1) throw new Error('unsupported fingerprint calibration schema')
  if (calibration['baseline_sha256'] !== baseline['content_sha256']) {
    throw new Error('fingerprint calibration baseline hash mismatch')
  }
  text(calibration['calibration_id'], 'fingerprint calibration id')
  text(calibration['source_replay_sha256'], 'fingerprint calibration source hash')
  if (calibration['threshold_operator'] !== '>') throw new Error('unsupported fingerprint calibration threshold operator')
  const thresholds = object(manifest['formal_thresholds'], 'manifest.formal_thresholds')
  const models = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
  const rows = calibration['formal_gate_reliability']
  if (!Array.isArray(rows) || rows.length !== 6) throw new Error('fingerprint calibration must contain six formal gate rows')
  const keys = new Set<string>()
  for (const [index, raw] of rows.entries()) {
    const row = object(raw, `fingerprint calibration row ${index}`)
    const tier = text(row['tier'], `fingerprint calibration row ${index}.tier`)
    const model = text(row['predicted_model'], `fingerprint calibration row ${index}.predicted_model`)
    if (!['medium', 'high'].includes(tier) || !models.has(model)) throw new Error('fingerprint calibration contains an unsupported scope')
    const key = `${tier}|${model}`
    if (keys.has(key)) throw new Error(`duplicate fingerprint calibration scope: ${key}`)
    keys.add(key)
    const threshold = finiteNumber(row['threshold'], `fingerprint calibration row ${index}.threshold`)
    const manifestThreshold = finiteNumber(object(thresholds[tier], `formal_thresholds.${tier}`)[model], `formal_thresholds.${tier}.${model}`)
    if (threshold !== manifestThreshold) throw new Error(`fingerprint calibration threshold mismatch: ${key}`)
    const selected = finiteNumber(row['selected'], `fingerprint calibration row ${index}.selected`)
    const correct = finiteNumber(row['correct'], `fingerprint calibration row ${index}.correct`)
    if (!Number.isInteger(selected) || !Number.isInteger(correct) || selected < 0 || correct < 0 || correct > selected) {
      throw new Error(`invalid fingerprint calibration counts: ${key}`)
    }
    if (row['calibration_available'] === true) {
      const precision = finiteNumber(row['observed_precision'], `fingerprint calibration row ${index}.observed_precision`)
      const lower = finiteNumber(row['wilson95_lower'], `fingerprint calibration row ${index}.wilson95_lower`)
      const upper = finiteNumber(row['wilson95_upper'], `fingerprint calibration row ${index}.wilson95_upper`)
      const epsilon = 1e-12
      if (selected === 0 || Math.abs(precision - correct / selected) > epsilon || lower < -epsilon || upper > 1 + epsilon || lower > precision + epsilon || precision > upper + epsilon) {
        throw new Error(`invalid fingerprint calibration interval: ${key}`)
      }
    } else if (selected !== 0 || correct !== 0 || row['observed_precision'] != null || row['wilson95_lower'] != null || row['wilson95_upper'] != null) {
      throw new Error(`unavailable fingerprint calibration must not contain estimates: ${key}`)
    }
  }
  return calibration
}

export async function importScoringRelease(manifestPath: string): Promise<ScoringReleaseSeed> {
  const manifestRaw = await readFile(manifestPath, 'utf8')
  const manifest = parseJson(manifestRaw, 'scoring release manifest')
  if (manifest['schema_version'] !== 1) throw new Error('unsupported scoring release manifest schema')
  const root = dirname(manifestPath)
  const artifacts = object(manifest['artifacts'], 'manifest.artifacts')
  const [catalogResult, baselineResult, calibrationResult] = await Promise.all([
    verifyArtifact(root, manifest, 'runtime_catalog'),
    verifyArtifact(root, manifest, 'fingerprint_baseline'),
    artifacts['fingerprint_calibration'] == null ? Promise.resolve(null) : verifyArtifact(root, manifest, 'fingerprint_calibration'),
  ])
  const catalog = catalogResult.value
  const baseline = baselineResult.value
  if (catalog['schema_version'] !== 1) throw new Error('unsupported runtime catalog schema')
  if (baseline['schema_version'] !== 3) throw new Error('unsupported fingerprint baseline schema')
  const baselineDescriptor = object(object(manifest['artifacts'], 'manifest.artifacts')['fingerprint_baseline'], 'fingerprint baseline descriptor')
  if (baseline['content_sha256'] !== baselineDescriptor['content_sha256']) throw new Error('fingerprint baseline content hash mismatch')
  if (calibrationResult != null) {
    const calibrationDescriptor = object(artifacts['fingerprint_calibration'], 'fingerprint calibration descriptor')
    if (calibrationDescriptor['baseline_content_sha256'] !== baseline['content_sha256']) {
      throw new Error('fingerprint calibration descriptor baseline hash mismatch')
    }
  }
  const fingerprintCalibration = calibrationResult == null ? null : validateFingerprintCalibration(calibrationResult.value, manifest, baseline)
  const modelGroups = object(manifest['models'], 'manifest.models')
  const targets = Array.isArray(modelGroups['target']) ? modelGroups['target'].map(String) : []
  if (targets.join(',') !== 'gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna') throw new Error('unexpected target model set')
  const legacy = Array.isArray(modelGroups['legacy']) ? modelGroups['legacy'].map(String) : []
  return {
    id: text(manifest['release_id'], 'release_id'),
    schemaVersion: Number(manifest['schema_version']),
    scoringVersion: text(manifest['scoring_version'], 'scoring_version'),
    contentSha256: sha256(manifestRaw),
    sourceSha256: sha256([catalogResult.raw, baselineResult.raw, calibrationResult?.raw].filter((item): item is string => item != null).map(sha256).join(':')),
    formalEligible: baseline['formal_eligible'] === true,
    thresholdPolicy: {
      formal_thresholds: object(manifest['formal_thresholds'], 'formal_thresholds'),
      completion_ratio: baseline['completion_ratio'],
      weight_formula: baseline['weight_formula'],
      fingerprint_calibration_id: fingerprintCalibration?.['calibration_id'] ?? null,
    },
    artifact: { ...baseline, fingerprint_calibration: fingerprintCalibration },
    models: [...targets.map((modelId) => ({ modelId, modelKind: 'target' as const })), ...legacy.map((modelId) => ({ modelId, modelKind: 'legacy' as const }))],
    probes: buildProbes(catalog, baseline),
    templates: buildTemplates(catalog),
    signatures: buildSignatures(manifest),
    cells: buildCells(baseline),
    calibrations: buildCalibrations(manifest, baseline),
    verdictRules: buildVerdictRules(manifest),
  }
}

export function defaultScoringReleaseManifest(cwd = process.cwd()): string {
  const root = basename(cwd) === 'backend' ? resolve(cwd, '..') : cwd
  return resolve(root, 'scoring-releases', 'gpt56-v4', 'manifest.json')
}
