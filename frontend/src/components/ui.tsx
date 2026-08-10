import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { AnomalyRecord, Provider, ProviderGroup, SourceKind } from '../data'
import { sourceLabel, sourceNote } from '../data'
import { modelConfidence, providerSourceConfidence, weakestLink } from '../confidence'
import { meterTone, severityLabel, severityTone } from '../scales'
import type { Tone } from '../scales'

/* -------------------------------------------------------------------------
 * Page scaffolding
 * ---------------------------------------------------------------------- */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  )
}

/* -------------------------------------------------------------------------
 * Status marks — reserved scale, always a mark plus a label
 * ---------------------------------------------------------------------- */

export function Pill({
  tone = 'neutral',
  dot = false,
  size,
  children,
}: {
  tone?: Tone
  dot?: boolean
  size?: 'sm'
  children: ReactNode
}) {
  const classes = ['pill', `pill-${tone}`, size === 'sm' ? 'pill-sm' : '']
  return (
    <span className={classes.filter(Boolean).join(' ')}>
      {dot && <span className="dot" aria-hidden="true" />}
      {children}
    </span>
  )
}

/* -------------------------------------------------------------------------
 * Confidence figures
 * ---------------------------------------------------------------------- */

export function ConfidenceFigure({
  value,
  size = 'lg',
}: {
  value: number
  size?: 'lg' | 'md'
}) {
  return (
    <span className={`confidence-number is-${meterTone(value)} is-${size}`}>
      <strong>{value}</strong>
      <span>%</span>
    </span>
  )
}

export function Meter({ value, showValue = true }: { value: number; showValue?: boolean }) {
  return (
    <div className="meter">
      <div className="meter-track">
        <span className={`meter-fill is-${meterTone(value)}`} style={{ width: `${value}%` }} />
      </div>
      {showValue && <strong className="meter-value">{value}%</strong>}
      <span className="sr-only">置信率 {value}%</span>
    </div>
  )
}

/* Single series, so no legend — the row heading names it. Renders fully
 * formed; the draw-in animation was removed in the tone-down pass. */
export function Sparkline({
  values,
  tone,
  label,
  width = 108,
  height = 30,
}: {
  values: number[]
  tone: 'good' | 'caution' | 'risk'
  label: string
  width?: number
  height?: number
}) {
  const pad = 4
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1

  const points = values.map((value, index) => {
    const x = pad + (index / (values.length - 1)) * (width - pad * 2)
    const y = pad + (1 - (value - min) / span) * (height - pad * 2)
    return [x, y] as const
  })

  const line = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')
  const last = points[points.length - 1]
  const area = `${line} L${last[0].toFixed(1)},${height} L${points[0][0].toFixed(1)},${height} Z`

  return (
    <svg
      className={`spark spark-${tone}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}：近 ${values.length} 期 ${values.join('、')}`}
    >
      <path className="spark-area" d={area} fill="currentColor" />
      <path className="spark-line" d={line} stroke="currentColor" />
      <circle className="spark-dot" cx={last[0]} cy={last[1]} r={3} fill="currentColor" />
    </svg>
  )
}

/* -------------------------------------------------------------------------
 * Weakest link
 *
 * A mean can hide one bad group, which on this product is exactly the signal
 * that matters — so whenever one exists it is printed next to the headline
 * rather than left to be discovered in the breakdown.
 * ---------------------------------------------------------------------- */

export function WeakestLinkWarning({ provider }: { provider: Provider }) {
  const weak = weakestLink(provider)
  if (!weak) return null

  return (
    <p className={weak.reason === 'low' ? 'weak-link' : 'weak-link is-spread'}>
      <AlertTriangle size={15} aria-hidden="true" />
      <span>
        {weak.groupLabel ? `${weak.groupLabel} ` : ''}
        <code>{weak.model}</code>{' '}
        {weak.reason === 'low'
          ? `仅 ${weak.confidence}%`
          : `${weak.confidence}%，比最高分组低 ${weak.gap} 个百分点`}
      </span>
    </p>
  )
}

/* -------------------------------------------------------------------------
 * Group / model breakdown
 * ---------------------------------------------------------------------- */

function GroupRow({ group }: { group: ProviderGroup }) {
  const named = group.kind !== 'none'

  return (
    <div className={named ? 'group-row' : 'group-row is-unnamed'}>
      {named && (
        <span className="group-name">
          {group.label}
          {group.multiplier != null && <span className="tag">{group.multiplier}x</span>}
        </span>
      )}
      <ul className="group-models">
        {group.models.map((entry) => {
          const value = modelConfidence(entry)
          return (
            <li key={entry.model}>
              <code>{entry.model}</code>
              {value == null ? (
                <span className="model-empty">无样本</span>
              ) : (
                <b className={`model-value is-${meterTone(value)}`}>{value}%</b>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function GroupBreakdown({ provider }: { provider: Provider }) {
  return (
    <div className="group-breakdown">
      {provider.groups.map((group) => (
        <GroupRow key={group.id} group={group} />
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Provider detail pieces
 * ---------------------------------------------------------------------- */

export function SourceCard({
  provider,
  source,
  active,
  onSelect,
}: {
  provider: Provider
  source: SourceKind
  active: boolean
  onSelect: () => void
}) {
  const { confidence, samples } = providerSourceConfidence(provider, source)
  const counts = source !== 'vendor'
  const anomalies = provider.anomalies.filter((record) => record.source === source)

  return (
    <button
      type="button"
      className={active ? 'source-card is-active' : 'source-card'}
      onClick={onSelect}
      aria-pressed={active}
    >
      <span className="source-head">
        <strong>{sourceLabel[source]}</strong>
        <Pill tone={counts ? 'neutral' : 'warn'} size="sm">
          {sourceNote[source]}
        </Pill>
      </span>
      {confidence == null ? (
        <span className="source-empty">暂无样本</span>
      ) : (
        <ConfidenceFigure value={confidence} size="md" />
      )}
      <span className="source-meta">
        {samples} 个样本 · {anomalies.length} 条异常记录
      </span>
    </button>
  )
}

export function AnomalyRow({ record }: { record: AnomalyRecord }) {
  return (
    <li className="anomaly-row">
      <span className="anomaly-when">
        <time dateTime={record.at}>{record.at.replace('T', ' ').replace(':00Z', ' UTC')}</time>
        <Pill tone={severityTone[record.severity]} size="sm" dot>
          {severityLabel[record.severity]}
        </Pill>
      </span>
      <span className="anomaly-where">
        <code>{record.model}</code>
        <span>{record.channel}</span>
      </span>
      <span className="anomaly-what">
        <span className="anomaly-probe">{record.probeId}</span>
        <span className="anomaly-diff">
          预期 <b>{record.expected}</b> · 实际 <b className="is-bad">{record.observed}</b>
        </span>
      </span>
    </li>
  )
}

/* -------------------------------------------------------------------------
 * Small shared pieces
 * ---------------------------------------------------------------------- */

export function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="def-list">
      {items.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  )
}
