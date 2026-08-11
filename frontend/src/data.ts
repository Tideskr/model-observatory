export type ProviderKind = 'relay' | 'official' | 'official_proxy'
export type SourceKind = 'vendor' | 'donated' | 'community'
export type GroupKind = 'none' | 'price' | 'tier'

export interface ModelEntry {
  model: string
  bySource: Record<SourceKind, number | null>
  samples: Record<SourceKind, number>
  availabilityBySource?: Record<SourceKind, number | null>
  attemptedSamples?: Record<SourceKind, number>
  inconclusiveSamples?: Record<SourceKind, number>
  attribution?: { verified: number; donor_declared: number }
}

export interface ProviderGroup {
  id: string
  kind: GroupKind
  label: string
  multiplier?: number
  models: ModelEntry[]
}

export interface AnomalyRecord {
  id: string
  at: string
  channel: string
  source: SourceKind
  model: string
  groupId?: string
  probeId: string
  expected: string
  observed: string
  severity: 'hard' | 'soft'
}

export interface Provider {
  slug: string
  name: string
  kind: ProviderKind
  endpoint: string
  domains?: string[]
  lastCheckedAt: string | null
  history: number[]
  groups: ProviderGroup[]
  anomalies: AnomalyRecord[]
}

export const providerKindLabel: Record<ProviderKind, string> = {
  relay: '中转',
  official: '官方 API',
  official_proxy: '官方反代',
}

export const sourceLabel: Record<SourceKind, string> = {
  vendor: '商家提供的 API',
  donated: '用户捐赠的 API',
  community: '社区维护的 API',
}

export const sourceNote: Record<SourceKind, string> = {
  vendor: '不计入综合置信率',
  donated: '计入综合置信率',
  community: '计入综合置信率',
}
