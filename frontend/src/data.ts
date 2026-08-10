/* Observation data — mock only.
 *
 * One `groups` array covers all three provider kinds, discriminated by
 * `GroupKind`. An official API is modelled as a single group with
 * kind 'none' rather than a separate ungrouped field, so every derivation
 * in confidence.ts works identically across kinds with no special casing.
 *
 * Confidence is never stored at provider level — it is derived from the
 * per-model, per-source numbers so the headline can never drift from the
 * breakdown printed under it. See confidence.ts.
 */

export type ProviderKind = 'relay' | 'official' | 'official_proxy'
export type SourceKind = 'vendor' | 'donated' | 'community'
export type GroupKind = 'none' | 'price' | 'tier'

export interface ModelEntry {
  model: string
  /** null = no samples from that source yet. Vendor never enters the headline. */
  bySource: Record<SourceKind, number | null>
  samples: Record<SourceKind, number>
}

export interface ProviderGroup {
  id: string
  kind: GroupKind
  /** Empty when kind is 'none' — the group header is not rendered. */
  label: string
  /** Price groups only, e.g. 0.05 for a 0.05x 倍率 group. */
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
  /** 'hard' mirrors Legacy's hard_anomaly; 'soft' is inconclusive evidence. */
  severity: 'hard' | 'soft'
}

export interface Provider {
  slug: string
  name: string
  kind: ProviderKind
  endpoint: string
  lastCheckedAt: string
  /** Headline confidence series, oldest to newest. */
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

export const providers: Provider[] = [
  {
    slug: 'relay-a',
    name: '中转 A',
    kind: 'relay',
    endpoint: 'api.relay-a.example',
    lastCheckedAt: '2026-08-10T08:34:00Z',
    history: [70, 71, 69, 74, 72, 75, 75],
    groups: [
      {
        id: 'low',
        kind: 'price',
        label: '低价分组',
        multiplier: 0.05,
        models: [
          {
            model: 'gpt-5.6-sol',
            bySource: { vendor: 88, donated: 34, community: 26 },
            samples: { vendor: 40, donated: 96, community: 132 },
          },
          {
            model: 'gpt-5.6-luna',
            bySource: { vendor: 95, donated: 82, community: 78 },
            samples: { vendor: 38, donated: 88, community: 124 },
          },
        ],
      },
      {
        id: 'high',
        kind: 'price',
        label: '高价分组',
        multiplier: 0.2,
        models: [
          {
            model: 'gpt-5.6-sol',
            bySource: { vendor: 96, donated: 93, community: 91 },
            samples: { vendor: 36, donated: 74, community: 108 },
          },
          {
            model: 'gpt-5.6-luna',
            bySource: { vendor: 99, donated: 99, community: 99 },
            samples: { vendor: 34, donated: 70, community: 102 },
          },
        ],
      },
    ],
    anomalies: [
      {
        id: 'anm-1041',
        at: '2026-08-10T06:12:00Z',
        channel: 'donated-node-7 / AS-Transit-B',
        source: 'donated',
        model: 'gpt-5.6-sol',
        groupId: 'low',
        probeId: 'output_luna_48',
        expected: '48',
        observed: '40',
        severity: 'hard',
      },
      {
        id: 'anm-1038',
        at: '2026-08-10T04:55:00Z',
        channel: 'community-node-2 / AS-Cloud-C',
        source: 'community',
        model: 'gpt-5.6-sol',
        groupId: 'low',
        probeId: 'juice_high',
        expected: '40（sol / high）',
        observed: '48（匹配 luna）',
        severity: 'hard',
      },
      {
        id: 'anm-1035',
        at: '2026-08-09T22:40:00Z',
        channel: 'community-node-5 / AS-Resi-D',
        source: 'community',
        model: 'gpt-5.6-sol',
        groupId: 'low',
        probeId: 'juice_coverage',
        expected: '57314（本次注入的合成值）',
        observed: '40',
        severity: 'hard',
      },
      {
        id: 'anm-1029',
        at: '2026-08-09T18:03:00Z',
        channel: 'donated-node-3 / AS-Cloud-A',
        source: 'donated',
        model: 'gpt-5.6-luna',
        groupId: 'low',
        probeId: 'rand_country',
        expected: '接近 luna 基线分布',
        observed: '分布偏移，JSD 超阈值',
        severity: 'soft',
      },
    ],
  },
  {
    slug: 'relay-b',
    name: '中转 B',
    kind: 'relay',
    endpoint: 'api.relay-b.example',
    lastCheckedAt: '2026-08-10T08:21:00Z',
    history: [86, 87, 88, 88, 90, 89, 90],
    groups: [
      {
        id: 'standard',
        kind: 'price',
        label: '标准分组',
        multiplier: 0.35,
        models: [
          {
            model: 'gpt-5.6-sol',
            bySource: { vendor: 94, donated: 89, community: 87 },
            samples: { vendor: 30, donated: 62, community: 94 },
          },
          {
            model: 'gpt-5.6-luna',
            bySource: { vendor: 96, donated: 92, community: 90 },
            samples: { vendor: 28, donated: 58, community: 88 },
          },
        ],
      },
      {
        id: 'premium',
        kind: 'price',
        label: '高倍分组',
        multiplier: 0.8,
        models: [
          {
            model: 'gpt-5.6-sol',
            bySource: { vendor: 98, donated: 94, community: 92 },
            samples: { vendor: 22, donated: 40, community: 61 },
          },
        ],
      },
    ],
    anomalies: [
      {
        id: 'anm-0974',
        at: '2026-08-08T13:20:00Z',
        channel: 'donated-node-1 / AS-Cloud-A',
        source: 'donated',
        model: 'gpt-5.6-sol',
        groupId: 'standard',
        probeId: 'juice_xhigh',
        expected: '128（sol / xhigh）',
        observed: '768（匹配 gpt-5.4-mini）',
        severity: 'hard',
      },
    ],
  },
  {
    slug: 'official-openai',
    name: 'OpenAI 官方 API',
    kind: 'official',
    endpoint: 'api.openai.com',
    lastCheckedAt: '2026-08-10T08:38:00Z',
    history: [97, 97, 98, 98, 98, 99, 99],
    groups: [
      {
        id: 'default',
        kind: 'none',
        label: '',
        models: [
          {
            model: 'gpt-5.6-sol',
            bySource: { vendor: null, donated: 99, community: 99 },
            samples: { vendor: 0, donated: 120, community: 186 },
          },
          {
            model: 'gpt-5.6-luna',
            bySource: { vendor: null, donated: 99, community: 98 },
            samples: { vendor: 0, donated: 114, community: 172 },
          },
          {
            model: 'gpt-5.6-terra',
            bySource: { vendor: null, donated: 98, community: 99 },
            samples: { vendor: 0, donated: 96, community: 158 },
          },
        ],
      },
    ],
    anomalies: [],
  },
  {
    slug: 'official-proxy-c',
    name: '官方反代 C',
    kind: 'official_proxy',
    endpoint: 'proxy-c.example',
    lastCheckedAt: '2026-08-10T07:58:00Z',
    history: [88, 86, 84, 83, 80, 79, 78],
    groups: [
      {
        id: 'pro',
        kind: 'tier',
        label: 'Pro 订阅',
        models: [
          {
            model: 'gpt-5.6-sol',
            bySource: { vendor: 97, donated: 95, community: 94 },
            samples: { vendor: 24, donated: 52, community: 80 },
          },
          {
            model: 'gpt-5.6-luna',
            bySource: { vendor: 96, donated: 93, community: 93 },
            samples: { vendor: 22, donated: 48, community: 74 },
          },
        ],
      },
      {
        id: 'plus',
        kind: 'tier',
        label: 'Plus 订阅',
        models: [
          {
            model: 'gpt-5.6-sol',
            bySource: { vendor: 92, donated: 63, community: 59 },
            samples: { vendor: 20, donated: 44, community: 66 },
          },
          {
            model: 'gpt-5.6-luna',
            bySource: { vendor: 94, donated: 71, community: 67 },
            samples: { vendor: 18, donated: 40, community: 62 },
          },
        ],
      },
    ],
    anomalies: [
      {
        id: 'anm-1012',
        at: '2026-08-09T15:47:00Z',
        channel: 'community-node-9 / AS-Resi-E',
        source: 'community',
        model: 'gpt-5.6-sol',
        groupId: 'plus',
        probeId: 'output_terra_32',
        expected: '32',
        observed: '40',
        severity: 'hard',
      },
      {
        id: 'anm-1008',
        at: '2026-08-09T11:02:00Z',
        channel: 'donated-node-4 / AS-Transit-B',
        source: 'donated',
        model: 'gpt-5.6-luna',
        groupId: 'plus',
        probeId: 'b80_letter_count',
        expected: '3',
        observed: '2',
        severity: 'soft',
      },
    ],
  },
]
