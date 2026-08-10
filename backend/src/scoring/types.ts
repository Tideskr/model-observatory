export interface ScoringModelSeed {
  modelId: string
  modelKind: 'target' | 'legacy'
}

export interface ScoringProbeSeed {
  probeId: string
  category: string
  prompt: string
  promptSha256: string
  developerPrompt: string
  developerPromptSha256: string
  normalizerId: string | null
  normalizer: Record<string, unknown> | null
  scoringKind: string
  promptRewriteAllowed: boolean
  metadata: Record<string, unknown>
}

export interface ScoringSignatureSeed {
  modelId: string
  effort: string
  expectedValue: string
  matchRule: 'exact' | 'exact_or_decimal_or_long_prefix'
}

export interface ScoringTemplateSeed {
  probeId: string
  templateId: string
  prompt: string
  promptSha256: string
  metadata: Record<string, unknown>
}

export interface ScoringCellSeed {
  probeId: string
  profile: string
  categories: unknown[]
  rawCounts: Record<string, unknown>
  fittedParameters: Record<string, unknown>
  quality: Record<string, unknown>
}

export interface ScoringCalibrationSeed {
  runtimeSignature: string
  runtimeName: string
  formalEligible: boolean
  requiredSamples: Record<string, unknown>
  exactContracts: Record<string, unknown>
  thresholds: Record<string, unknown>
  oodThresholds: Record<string, unknown>
  details: Record<string, unknown>
}

export interface VerdictRuleSeed {
  priority: number
  ruleId: string
  title: string | null
  predicateId: string
  severe: boolean
}

export interface ScoringReleaseSeed {
  id: string
  schemaVersion: number
  scoringVersion: string
  contentSha256: string
  sourceSha256: string
  formalEligible: boolean
  thresholdPolicy: Record<string, unknown>
  artifact: Record<string, unknown>
  models: ScoringModelSeed[]
  probes: ScoringProbeSeed[]
  templates: ScoringTemplateSeed[]
  signatures: ScoringSignatureSeed[]
  cells: ScoringCellSeed[]
  calibrations: ScoringCalibrationSeed[]
  verdictRules: VerdictRuleSeed[]
}
