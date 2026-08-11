import { ArrowLeft, FileSearch } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { providerKindLabel, sourceLabel } from '../data'
import type { SourceKind } from '../data'
import { providerHeadline } from '../confidence'
import { meterTone } from '../scales'
import { useRelativeTime } from '../hooks/useMotion'
import {
  AnomalyRow,
  ConfidenceFigure,
  EmptyState,
  GroupBreakdown,
  PageHeader,
  Sparkline,
  SourceCard,
  WeakestLinkWarning,
} from '../components/ui'
import { usePublicData } from '../api/publicData'

const sources: SourceKind[] = ['community', 'donated', 'vendor']

export function ProviderPage() {
  const { slug } = useParams()
  const { providers } = usePublicData()
  const [params, setParams] = useSearchParams()

  const provider = providers.find((item) => item.slug === slug)
  const checked = useRelativeTime(new Date(provider?.lastCheckedAt ?? 0))
  const requestedSource = params.get('source') as SourceKind | null
  const selected = requestedSource && sources.includes(requestedSource) ? requestedSource : 'community'
  const records = useMemo(
    () =>
      provider
        ? provider.anomalies
            .filter((record) => record.source === selected)
            .toSorted((a, b) => b.at.localeCompare(a.at))
        : [],
    [provider, selected],
  )
  if (!provider) {
    return (
      <div className="stack">
        <Link className="back-link" to="/">
          <ArrowLeft size={16} /> 返回观测面板
        </Link>
        <EmptyState icon={<FileSearch size={22} />} title="未找到该提供商" />
      </div>
    )
  }
  const headline = providerHeadline(provider)

  function selectSource(source: SourceKind) {
    const next = new URLSearchParams(params)
    next.set('source', source)
    setParams(next, { replace: true })
  }

  return (
    <div className="stack">
      <div>
        <Link className="back-link" to="/">
          <ArrowLeft size={16} /> 返回观测面板
        </Link>
        <PageHeader
          title={provider.name}
          description={`${providerKindLabel[provider.kind]} · ${provider.endpoint}`}
        />
      </div>

      <section className="card card-pad verdict-card">
        <div className="verdict-figure">
          <ConfidenceFigure value={headline} />
          <div className="verdict-meta">
            <span className="t-label">综合置信率</span>
            <span>各模型算术均值 · 不含商家自报 · {provider.lastCheckedAt ? `更新于 ${checked}` : '尚未完成检测'}</span>
          </div>
          <Sparkline
            values={provider.history}
            tone={meterTone(headline)}
            label={`${provider.name} 综合置信率`}
            width={160}
            height={40}
          />
        </div>
        <WeakestLinkWarning provider={provider} />
        <GroupBreakdown provider={provider} />
      </section>

      <section className="card">
        <div className="card-head">
          <div className="card-head-text">
            <h2>分来源置信率</h2>
            <p>三类来源分别计数，不合并成一个票数。选择一类查看其异常记录。</p>
          </div>
        </div>
        <div className="source-grid">
          {sources.map((source) => (
            <SourceCard
              key={source}
              provider={provider}
              source={source}
              active={selected === source}
              onSelect={() => selectSource(source)}
            />
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div className="card-head-text">
            <h2>{sourceLabel[selected]} · 异常记录</h2>
            <p>每条记录对应一次不符合预期的检测结果。</p>
          </div>
          <span className="card-head-aside">{records.length} 条</span>
        </div>
        {records.length === 0 ? (
          <EmptyState icon={<FileSearch size={22} />} title="该来源暂无异常记录">
            这不代表不存在问题，只表示当前样本内没有观察到超过阈值的差异。
          </EmptyState>
        ) : (
          <ul className="anomaly-list">
            {records.map((record) => (
              <AnomalyRow key={record.id} record={record} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
