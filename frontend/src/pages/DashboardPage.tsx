import { ChevronRight, ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { providerKindLabel } from '../data'
import type { Provider } from '../data'
import { byRisk, providerHeadline, weakestLink } from '../confidence'
import { meterTone } from '../scales'
import { useRelativeTime } from '../hooks/useMotion'
import { SelectField } from '../components/Fields'
import {
  ConfidenceFigure,
  GroupBreakdown,
  PageHeader,
  Sparkline,
  WeakestLinkWarning,
} from '../components/ui'
import { usePublicData } from '../api/publicData'

const sortOptions = [
  { value: 'risk', label: '风险优先' },
  { value: 'confidence', label: '置信率由低到高' },
  { value: 'name', label: '名称' },
]

function ProviderBlock({ provider }: { provider: Provider }) {
  const headline = providerHeadline(provider)
  const checked = useRelativeTime(new Date(provider.lastCheckedAt))

  return (
    <li className="provider-block">
      <Link to={`/providers/${provider.slug}`} className="provider-link">
        <span className="provider-title">
          <strong>{provider.name}</strong>
          <span className="tag">{providerKindLabel[provider.kind]}</span>
          <span className="provider-endpoint">{provider.endpoint}</span>
        </span>

        <span className="provider-headline">
          <ConfidenceFigure value={headline} />
          <Sparkline
            values={provider.history}
            tone={meterTone(headline)}
            label={`${provider.name} 综合置信率`}
          />
          <span className="provider-checked">{checked}</span>
        </span>

        <ChevronRight className="provider-chevron" size={18} aria-hidden="true" />
      </Link>

      <WeakestLinkWarning provider={provider} />
      <GroupBreakdown provider={provider} />
    </li>
  )
}

export function DashboardPage() {
  const [sort, setSort] = useState('risk')
  const { providers } = usePublicData()

  const visible = useMemo(() => {
    const rows = [...providers]
    if (sort === 'confidence') {
      return rows.sort((a, b) => providerHeadline(a) - providerHeadline(b))
    }
    if (sort === 'name') {
      return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
    }
    return rows.sort(byRisk)
  }, [providers, sort])

  const flagged = providers.filter((provider) => weakestLink(provider) != null)

  return (
    <div className="stack">
      <PageHeader
        title="观测面板"
        description="按提供商展示综合置信率与分组明细。综合值取各模型算术均值，不包含商家自报数据。"
        actions={
          <SelectField
            value={sort}
            onValueChange={setSort}
            options={sortOptions}
            srLabel="排序方式"
            width="176px"
          />
        }
      />

      {flagged.length > 0 && (
        <section className="notice notice-bad">
          <span className="notice-icon">
            <ShieldAlert size={19} />
          </span>
          <div className="notice-body">
            <strong>{flagged.length} 个提供商存在低置信分组</strong>
            <p>综合均值会掩盖单个分组的问题，下方每个提供商的短板已单独标出。</p>
          </div>
        </section>
      )}

      <ol className="provider-list">
        {visible.map((provider) => (
          <ProviderBlock key={provider.slug} provider={provider} />
        ))}
      </ol>

      <p className="page-foot-note">
        置信率只反映所列账号、节点与时间窗口内的观测结果，不构成对模型身份的保证。
      </p>
    </div>
  )
}
