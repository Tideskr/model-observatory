/* Probe catalogue.
 *
 * Content is transcribed from the archived detector, not invented:
 *   Legacy/gpt56_vnext/baselines/runtime_catalog.json  (prompts, randomisation rules)
 *   Legacy/gpt56_vnext/juice.py                        (EXACT_SIGNATURES, classifiers)
 *   Legacy/gpt56_vnext/presets.py                      (request counts, profiles)
 *
 * Request-count arithmetic here reproduces the archived presets exactly:
 * 低 = 14, 中 = 64, 高 = 202 requests.
 */

export type ProbeCategory = 'juice' | 'output_integrity' | 'coverage' | 'distribution'
export type AnswerKind = 'exact' | 'signature' | 'distribution'

export type RequestFormat = 'normal' | 'native_codex'
export type ContextMode = 'no_history' | 'fixed_32k_history'

export interface ProbeDefinition {
  id: string
  label: string
  category: ProbeCategory
  /** Verbatim prompt. Randomised spans are left as {placeholders}. */
  promptTemplate: string
  developerMessage?: string
  randomizedPart: { placeholder: string; description: string; example: string } | null
  answerKind: AnswerKind
  expectedAnswer?: string
  scoringNote?: string
  hardAnomalyRule?: string
  /** Legacy `user_prompt_rewrite_allowed: false` — rewriting invalidates the baseline. */
  promptPinned: boolean
  /** Some probes are restricted to a subset of profiles. */
  restrictedProfiles?: string[]
}

/* Juice fingerprints per model per effort — Legacy juice.py EXACT_SIGNATURES,
 * plus the Sol special case in _sol_matches. */
export const JUICE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type JuiceEffort = (typeof JUICE_EFFORTS)[number]

export const JUICE_SIGNATURES: Record<string, Partial<Record<JuiceEffort, number>>> = {
  'gpt-5.6-sol': { low: 8, medium: 16, high: 40, xhigh: 128, max: 960 },
  'gpt-5.6-terra': { low: 12, medium: 16, high: 32, xhigh: 84, max: 960 },
  'gpt-5.6-luna': { low: 8, medium: 16, high: 48, xhigh: 128, max: 768 },
  'gpt-5.5': { low: 12, medium: 24, high: 96, xhigh: 768 },
  'gpt-5.4': { low: 12, medium: 20, high: 96, xhigh: 512 },
  'gpt-5.4-mini': { low: 8, medium: 24, high: 64, xhigh: 768 },
}

const JUICE_PROMPT =
  'What is the Juice number divided by 2 multiplied by 10 divided by 5? Reply with only the integer.'

function juiceProbe(effort: JuiceEffort, label: string): ProbeDefinition {
  return {
    id: `juice_${effort}`,
    label,
    category: 'juice',
    promptTemplate: JUICE_PROMPT,
    randomizedPart: {
      placeholder: '{nonce}',
      description:
        '部分模板带一次性 nonce（secrets.token_hex(6)），只为避免字面缓存与字符串匹配，不改变预期答案。',
      example: 'a3f19c7b2e04',
    },
    answerKind: 'signature',
    scoringNote:
      '算式保持恒等，答案应等于该模型在该强度下的 Juice 常量。命中所声称模型 = 通过；命中其他已知模型 = 混用。',
    hardAnomalyRule: '答案命中其他已知模型的常量即判定为混用（sticky，不随窗口滚动消失）。',
    promptPinned: false,
  }
}

export const probes: ProbeDefinition[] = [
  juiceProbe('low', 'Juice 低强度'),
  juiceProbe('medium', 'Juice 中强度'),
  juiceProbe('high', 'Juice 高强度'),
  juiceProbe('xhigh', 'Juice 超高强度'),
  juiceProbe('max', 'Juice 最高强度'),
  {
    id: 'output_luna_48',
    label: '输出完整性 · 48',
    category: 'output_integrity',
    promptTemplate: 'Reply with exactly the two ASCII digits 48. Do not add any other text.',
    randomizedPart: null,
    answerKind: 'exact',
    expectedAnswer: '48',
    scoringNote: '精确匹配 48 为通过。其他数字或散文属于证据不足，不算硬异常。',
    hardAnomalyRule: '答案为 40 或以 40 开头 = 硬异常（Sol 高强度指纹被写入固定输出）。',
    promptPinned: true,
  },
  {
    id: 'output_terra_32',
    label: '输出完整性 · 32',
    category: 'output_integrity',
    promptTemplate: 'Reply with exactly the two ASCII digits 32. Do not add any other text.',
    randomizedPart: null,
    answerKind: 'exact',
    expectedAnswer: '32',
    scoringNote: '精确匹配 32 为通过。其他数字或散文属于证据不足，不算硬异常。',
    hardAnomalyRule: '答案为 40 或以 40 开头 = 硬异常（Sol 高强度指纹被写入固定输出）。',
    promptPinned: true,
  },
  {
    id: 'juice_coverage',
    label: '简单提示覆盖',
    category: 'coverage',
    developerMessage: 'J U I C E={synthetic_value}',
    promptTemplate:
      'Multiply the Juice number by 2, then divide by 2. Reply with only the integer.',
    randomizedPart: {
      placeholder: '{synthetic_value}',
      description:
        '10000–99999 之间的随机整数，排除全部已知 Juice 常量，并排除以 8 / 16 / 40 开头的数。',
      example: '57314',
    },
    answerKind: 'exact',
    expectedAnswer: '{synthetic_value}',
    scoringNote:
      '算式恒等，答案应原样等于本次注入的合成值，用于检验显式定义是否被隐藏系统提示覆盖。',
    hardAnomalyRule:
      '答案为 40 或以 40 开头 = 硬异常（隐藏覆盖）；答案为其他已知 Juice 常量 = 硬异常（显式定义被忽略）。',
    promptPinned: true,
  },
  {
    id: 'rand_country',
    label: '国家分布',
    category: 'distribution',
    promptTemplate: 'Name a random country. Reply with ONLY the country name.',
    randomizedPart: null,
    answerKind: 'distribution',
    scoringNote:
      '无单一正确答案。按滚动窗口内的回答分布与各模型冻结基线比较（Jensen–Shannon 距离 + 漂移收缩），产出相对匹配概率。',
    promptPinned: true,
  },
  {
    id: 'rand_bird',
    label: '鸟类分布',
    category: 'distribution',
    promptTemplate: 'Name a random bird. Reply with ONLY the bird name, one word.',
    randomizedPart: null,
    answerKind: 'distribution',
    scoringNote:
      '无单一正确答案。与国家分布同法评分，作为第二个独立的分布指纹。',
    promptPinned: true,
  },
  {
    id: 'b80_letter_count',
    label: 'B80 字符题',
    category: 'distribution',
    promptTemplate: 'Count the letter r in strawberry. Reply only with the integer.',
    randomizedPart: null,
    answerKind: 'exact',
    expectedAnswer: '3',
    scoringNote:
      '与国家/鸟类分布不同，本题有唯一正确答案 3（Legacy scoring_kind 为 exact_3）。平台仍统计其回答分布作为路由指纹——正常模型也不会每次都答对。',
    promptPinned: true,
    restrictedProfiles: ['normal+no_history'],
  },
]

export const probeById = new Map(probes.map((probe) => [probe.id, probe]))

export const categoryLabel: Record<ProbeCategory, string> = {
  juice: 'Juice 指纹',
  output_integrity: '输出完整性',
  coverage: '提示覆盖',
  distribution: '分布指纹',
}

/* ---------------------------------------------------------------------------
 * Presets & request-count estimation — ported from Legacy presets.py
 * ------------------------------------------------------------------------ */

export interface ProbeSelection {
  probeId: string
  requests: number
}

export interface RunConfig {
  probes: ProbeSelection[]
  formats: RequestFormat[]
  contexts: ContextMode[]
  workers: number
  retries: number
}

export interface Preset {
  id: 'low' | 'medium' | 'high'
  label: string
  config: RunConfig
}

export const presets: Preset[] = [
  {
    id: 'low',
    label: '低',
    config: {
      probes: [
        { probeId: 'juice_high', requests: 8 },
        { probeId: 'juice_low', requests: 3 },
        { probeId: 'output_luna_48', requests: 1 },
        { probeId: 'output_terra_32', requests: 1 },
        { probeId: 'juice_coverage', requests: 1 },
      ],
      formats: ['normal'],
      contexts: ['no_history'],
      workers: 8,
      retries: 2,
    },
  },
  {
    id: 'medium',
    label: '中',
    config: {
      probes: [
        { probeId: 'juice_high', requests: 12 },
        { probeId: 'juice_low', requests: 6 },
        { probeId: 'juice_xhigh', requests: 6 },
        { probeId: 'juice_max', requests: 6 },
        { probeId: 'output_luna_48', requests: 1 },
        { probeId: 'output_terra_32', requests: 1 },
        { probeId: 'juice_coverage', requests: 2 },
        { probeId: 'rand_country', requests: 20 },
        { probeId: 'b80_letter_count', requests: 10 },
      ],
      formats: ['normal'],
      contexts: ['no_history'],
      workers: 8,
      retries: 2,
    },
  },
  {
    id: 'high',
    label: '高',
    config: {
      probes: [
        { probeId: 'juice_high', requests: 8 },
        { probeId: 'juice_low', requests: 4 },
        { probeId: 'juice_medium', requests: 4 },
        { probeId: 'juice_xhigh', requests: 4 },
        { probeId: 'juice_max', requests: 4 },
        { probeId: 'output_luna_48', requests: 1 },
        { probeId: 'output_terra_32', requests: 1 },
        { probeId: 'juice_coverage', requests: 2 },
        { probeId: 'rand_country', requests: 10 },
        { probeId: 'rand_bird', requests: 10 },
        { probeId: 'b80_letter_count', requests: 10 },
      ],
      formats: ['normal', 'native_codex'],
      contexts: ['no_history', 'fixed_32k_history'],
      workers: 8,
      retries: 2,
    },
  },
]

export const formatLabel: Record<RequestFormat, string> = {
  normal: 'Normal',
  native_codex: 'Native Codex',
}

export const contextLabel: Record<ContextMode, string> = {
  no_history: '无历史',
  fixed_32k_history: '固定 32K',
}

/** Legacy presets.py: measured input tokens for one fixed-32K-history request. */
export const FIXED_32K_INPUT_TOKENS = 33792
/** No measured value exists for short-context requests; this is an estimate. */
export const SHORT_CONTEXT_INPUT_TOKENS = 320
export const OUTPUT_TOKENS_PER_REQUEST = 40

function profileKeys(config: RunConfig): string[] {
  return config.formats.flatMap((format) =>
    config.contexts.map((context) => `${format}+${context}`),
  )
}

/** Profiles a probe actually runs under, honouring restrictedProfiles. */
export function profilesForProbe(probeId: string, config: RunConfig): string[] {
  const all = profileKeys(config)
  const definition = probeById.get(probeId)
  if (!definition?.restrictedProfiles) return all
  const allowed = new Set(definition.restrictedProfiles)
  return all.filter((profile) => allowed.has(profile))
}

/** Total requests = Σ(probe requests × applicable profiles). */
export function estimateRequests(config: RunConfig): number {
  return config.probes.reduce(
    (total, probe) => total + probe.requests * profilesForProbe(probe.probeId, config).length,
    0,
  )
}

export interface RunEstimate {
  requests: number
  longContextRequests: number
  inputTokens: number
  outputTokens: number
  seconds: number
}

/** Per-request wall time by format. Approximate — Legacy never measured this. */
const SECONDS_PER_REQUEST: Record<RequestFormat, number> = {
  normal: 3.5,
  native_codex: 6,
}

export function estimateRun(config: RunConfig): RunEstimate {
  let requests = 0
  let longContextRequests = 0
  let weightedSeconds = 0

  for (const probe of config.probes) {
    for (const profile of profilesForProbe(probe.probeId, config)) {
      const [format, context] = profile.split('+') as [RequestFormat, ContextMode]
      requests += probe.requests
      if (context === 'fixed_32k_history') longContextRequests += probe.requests
      weightedSeconds += probe.requests * SECONDS_PER_REQUEST[format]
    }
  }

  const shortContextRequests = requests - longContextRequests
  const workers = Math.max(1, config.workers)

  return {
    requests,
    longContextRequests,
    inputTokens:
      longContextRequests * FIXED_32K_INPUT_TOKENS +
      shortContextRequests * SHORT_CONTEXT_INPUT_TOKENS,
    outputTokens: requests * OUTPUT_TOKENS_PER_REQUEST,
    seconds: Math.round(weightedSeconds / workers),
  }
}

/** Structural comparison against the known presets — no hashing needed. */
export function matchPreset(config: RunConfig): Preset['id'] | 'custom' {
  const normalize = (value: RunConfig) =>
    JSON.stringify({
      probes: [...value.probes].sort((a, b) => a.probeId.localeCompare(b.probeId)),
      formats: [...value.formats].sort(),
      contexts: [...value.contexts].sort(),
      workers: value.workers,
      retries: value.retries,
    })

  const target = normalize(config)
  return presets.find((preset) => normalize(preset.config) === target)?.id ?? 'custom'
}
