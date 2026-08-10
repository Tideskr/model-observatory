/* Confidence derivation.
 *
 * Business rules, deliberately separate from scales.ts (which is pure visual
 * mapping) so changing a threshold here cannot ripple into the colour system.
 *
 * Rule 1: vendor-supplied numbers never enter the headline. They are shown on
 *         the provider detail page only, labelled as excluded.
 * Rule 2: the headline is the arithmetic mean over every model in every group,
 *         so it is always reproducible from the breakdown printed beneath it.
 * Rule 3: a mean can hide a bad group, so a weakest-link warning is mandatory
 *         whenever any single model falls below the threshold.
 */

import type { ModelEntry, Provider, SourceKind } from './data'

/** Sources that count toward the public headline. */
export const HEADLINE_SOURCES: SourceKind[] = ['donated', 'community']

/** Shares meterTone's 50% breakpoint — one risk vocabulary, not two. */
export const WEAKEST_LINK_THRESHOLD = 50

/* A provider can look fine on the mean while one group is far behind: a
 * reverse proxy scoring 95 on Pro and 61 on Plus averages to a comfortable 80.
 * Averaging that away is the exact failure the warning exists to prevent, so
 * a wide spread triggers it even when nothing crosses the absolute floor. */
export const WEAKEST_LINK_SPREAD = 25

function mean(values: number[]): number | null {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Mean of the counting sources for one model; null when it has no samples. */
export function modelConfidence(entry: ModelEntry): number | null {
  const values = HEADLINE_SOURCES.map((source) => entry.bySource[source]).filter(
    (value): value is number => value != null,
  )
  const value = mean(values)
  return value == null ? null : Math.round(value)
}

export function modelSamples(entry: ModelEntry): number {
  return HEADLINE_SOURCES.reduce((sum, source) => sum + entry.samples[source], 0)
}

/** Every scored model across every group, flattened. */
function scoredModels(provider: Provider) {
  return provider.groups.flatMap((group) =>
    group.models.map((entry) => ({
      group,
      entry,
      confidence: modelConfidence(entry),
    })),
  )
}

/** Provider headline: arithmetic mean across all models in all groups. */
export function providerHeadline(provider: Provider): number {
  const values = scoredModels(provider)
    .map((row) => row.confidence)
    .filter((value): value is number => value != null)
  return Math.round(mean(values) ?? 0)
}

export interface WeakestLink {
  /** null when the provider has no real grouping (official API). */
  groupLabel: string | null
  model: string
  confidence: number
  /** 'low' = below the absolute floor; 'spread' = far behind the best group. */
  reason: 'low' | 'spread'
  /** Gap to the strongest model, for the 'spread' case. */
  gap: number
}

/** Worst model, flagged when it is either below the floor or far behind. */
export function weakestLink(provider: Provider): WeakestLink | null {
  const rows = scoredModels(provider).filter(
    (row): row is typeof row & { confidence: number } => row.confidence != null,
  )
  if (!rows.length) return null

  const worst = rows.reduce((low, row) => (row.confidence < low.confidence ? row : low))
  const best = rows.reduce((high, row) => (row.confidence > high.confidence ? row : high))
  const gap = best.confidence - worst.confidence

  const reason =
    worst.confidence < WEAKEST_LINK_THRESHOLD
      ? 'low'
      : gap >= WEAKEST_LINK_SPREAD
        ? 'spread'
        : null

  if (!reason) return null

  return {
    groupLabel: worst.group.kind === 'none' ? null : worst.group.label,
    model: worst.entry.model,
    confidence: worst.confidence,
    reason,
    gap,
  }
}

/** Confidence for one source across the whole provider — detail page only. */
export function providerSourceConfidence(
  provider: Provider,
  source: SourceKind,
): { confidence: number | null; samples: number } {
  const values: number[] = []
  let samples = 0

  for (const group of provider.groups) {
    for (const entry of group.models) {
      const value = entry.bySource[source]
      if (value != null) values.push(value)
      samples += entry.samples[source]
    }
  }

  const value = mean(values)
  return { confidence: value == null ? null : Math.round(value), samples }
}

/** Providers ordered worst-first — the ordering the dashboard defaults to. */
export function byRisk(a: Provider, b: Provider): number {
  const aWeak = weakestLink(a)
  const bWeak = weakestLink(b)
  if (aWeak && !bWeak) return -1
  if (bWeak && !aWeak) return 1
  return providerHeadline(a) - providerHeadline(b)
}
