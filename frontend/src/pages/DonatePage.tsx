import { Check, CloudCog, Eye, EyeOff, KeyRound, Mail, Network, ShieldAlert } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { RadioGroup } from 'radix-ui'
import { toast } from 'sonner'
import { submitApiDonation, type DonationReceipt, type PreparedDonationSubmission } from '../api/contributions'
import { providers, providerKindLabel } from '../data'
import { presets, estimateRun } from '../probes'
import { DEFAULT_PRICE, estimateCost, formatUsd } from '../pricing'
import { CheckField, FormSelect } from '../components/Fields'
import { PageHeader, Pill } from '../components/ui'

type DonationKind = 'proxy' | 'api' | 'vendor'

const kinds = [
  {
    id: 'proxy' as const,
    icon: Network,
    label: 'HTTP 代理',
    note: '最需要的一类',
  },
  {
    id: 'api' as const,
    icon: KeyRound,
    label: 'API 凭据',
    note: '需限额与并发上限',
  },
  {
    id: 'vendor' as const,
    icon: CloudCog,
    label: '商家捐赠',
    note: '特殊渠道，邮件确认',
  },
]

/* One monitoring pass costs roughly what the 中 preset costs. Used to project
 * how long a donated quota will last. */
const PASS = estimateRun(presets[1].config)

function projectExhaustion(quotaUsd: number, intervalMinutes: number, multiplier: number) {
  const perPass = estimateCost(PASS.inputTokens, PASS.outputTokens, DEFAULT_PRICE, multiplier)
  if (perPass <= 0 || intervalMinutes <= 0) return null
  const passesPerDay = 1440 / intervalMinutes
  const days = quotaUsd / (perPass * passesPerDay)
  return { perPass, passesPerDay, days }
}

function formatDays(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} 小时`
  if (days < 60) return `${days.toFixed(1)} 天`
  return `${(days / 30).toFixed(1)} 个月`
}

export function DonatePage() {
  const [kind, setKind] = useState<DonationKind>('proxy')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [quota, setQuota] = useState(10)
  const [interval, setInterval] = useState(240)
  const [multiplier, setMultiplier] = useState(0.2)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<DonationReceipt | null>(null)
  const pendingSubmission = useRef<{
    fingerprint: string
    idempotencyKey: string
    prepared?: PreparedDonationSubmission
  } | null>(null)

  async function submitDonation() {
    setSubmitting(true)
    try {
      const fingerprint = JSON.stringify({ baseUrl: baseUrl.trim(), apiKey, quota, interval })
      if (pendingSubmission.current?.fingerprint !== fingerprint) {
        pendingSubmission.current = { fingerprint, idempotencyKey: crypto.randomUUID() }
      }
      const created = await submitApiDonation({
        baseUrl: baseUrl.trim(), apiKey, quotaUsd: quota, intervalMinutes: interval,
        idempotencyKey: pendingSubmission.current.idempotencyKey,
        prepared: pendingSubmission.current.prepared,
        onPrepared: (prepared) => {
          if (pendingSubmission.current?.fingerprint === fingerprint) pendingSubmission.current.prepared = prepared
        },
      })
      pendingSubmission.current = null
      setApiKey('')
      setConsent(false)
      setReceipt(created)
      toast.success('凭据已进入隔离区')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  /* The donor should not have to say which vendor or price group their key
     belongs to — it is inferable from the endpoint, and asking invites errors. */
  const detected = useMemo(() => {
    const host = baseUrl.trim().replace(/^https?:\/\//, '').split('/')[0]
    if (!host) return null
    return providers.find((provider) => host.endsWith(provider.endpoint)) ?? null
  }, [baseUrl])

  const projection = useMemo(
    () => projectExhaustion(quota, interval, multiplier),
    [interval, multiplier, quota],
  )

  return (
    <div className="stack">
      <PageHeader
        title="捐赠节点"
        description="观测需要多样的出口网络与账号。凭据只在你限定的范围内使用，随时可撤销。"
      />

      <RadioGroup.Root
        className="choice-grid choice-grid-3"
        value={kind}
        onValueChange={(value) => setKind(value as DonationKind)}
        aria-label="捐赠类型"
      >
        {kinds.map(({ id, icon: Icon, label, note }) => (
          <RadioGroup.Item value={id} key={id} asChild>
            <button type="button" className={kind === id ? 'choice is-active' : 'choice'}>
              <span className="choice-icon">
                <Icon size={17} />
              </span>
              <span className="choice-text">
                <strong>{label}</strong>
                <small>{note}</small>
              </span>
              {kind === id && <Check size={16} />}
            </button>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>

      {kind === 'proxy' && (
        <section className="card card-pad">
          <div className="step-head">
            <span className="step-num">1</span>
            <div>
              <h2>捐赠 HTTP 代理</h2>
              <p>这是目前最缺的一类资源。</p>
            </div>
          </div>
          <p className="lead-note">
            没有足够的独立出口，检测就只能从少数固定 IP 发出——这些 IP 会被中转商识别并「洗白」，
            即对来自它们的请求单独路由到真模型，使检测结果失去意义。捐赠代理直接提高这件事的成本。
          </p>
          <div className="field-grid">
            <FormSelect label="代理协议" options={['HTTP', 'HTTPS', 'SOCKS5']} />
            <FormSelect
              label="出口地区"
              options={['亚太', '北美', '欧洲', '南美', '非洲', '其他']}
            />
            <label className="field">
              <span>地址与端口</span>
              <input placeholder="host:port" spellCheck={false} />
            </label>
            <label className="field">
              <span>并发上限</span>
              <input type="number" min={1} defaultValue={4} />
            </label>
            <FormSelect
              label="网络类型"
              options={['住宅', '机房', '移动', '机构']}
              full
            />
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => toast.success('已记录代理捐赠意向（本地原型）')}
            >
              提交代理
            </button>
            <span>原型不会发送任何内容</span>
          </div>
        </section>
      )}

      {kind === 'api' && (
        <div className="split">
          <section className="card card-pad">
            <div className="step-head">
              <span className="step-num">1</span>
              <div>
                <h2>捐赠 API 凭据</h2>
                <p>建议设置额度上限，并只授权到检测所需的模型。</p>
              </div>
            </div>

            <div className="field-grid">
              <label className="field is-full">
                <span>base_url</span>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://api.relay-a.example"
                  spellCheck={false}
                />
              </label>
              <label className="field is-full">
                <span>api_key</span>
                <div className="secret">
                  <KeyRound size={16} aria-hidden="true" />
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="建议限额、限模型、可撤销"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((value) => !value)}
                    aria-label={showKey ? '隐藏 api_key' : '显示 api_key'}
                  >
                    {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>额度上限（US$）</span>
                <input
                  type="number"
                  min={1}
                  value={quota}
                  onChange={(event) => setQuota(Number(event.target.value) || 0)}
                />
              </label>
              <label className="field">
                <span>并发限制</span>
                <input type="number" min={1} max={16} defaultValue={2} />
              </label>
              <label className="field">
                <span>检测间隔（分钟）</span>
                <input
                  type="number"
                  min={30}
                  value={interval}
                  onChange={(event) => setInterval(Number(event.target.value) || 0)}
                />
              </label>
              <label className="field">
                <span>分组倍率</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={multiplier}
                  onChange={(event) => setMultiplier(Number(event.target.value) || 0)}
                />
              </label>
            </div>

            <div className="detected-row">
              <span className="t-label">自动识别</span>
              {detected ? (
                <span>
                  {providerKindLabel[detected.kind]} · <strong>{detected.name}</strong> · 分组将在首次检测后确认
                </span>
              ) : (
                <span className="t-faint">
                  {baseUrl.trim() ? '未匹配到已知提供商，将在首次检测后归类' : '填写 base_url 后自动识别商家与分组'}
                </span>
              )}
            </div>

            <CheckField checked={consent} onCheckedChange={setConsent}>
              我同意服务端在所列额度和频率内使用该凭据；凭据将加密保存，并可使用一次性撤销令牌撤销。
            </CheckField>

            {receipt && (
              <div className="detected-row" role="status">
                <span className="t-label">撤销令牌</span>
                <span>
                  <code>{receipt.revocation_token}</code>
                  <br />
                  <span className="t-faint">捐赠 {receipt.donation_id} · 隔离中 · 指纹尾部 {receipt.credential_fingerprint_tail}</span>
                </span>
              </div>
            )}

            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!baseUrl.trim() || !apiKey.trim() || !consent || submitting}
                onClick={() => void submitDonation()}
              >
                {submitting ? '提交中…' : '提交凭据'}
              </button>
              <span>成功后只显示一次撤销令牌</span>
            </div>
          </section>

          <aside className="card split-aside">
            <div className="card-head">
              <div className="card-head-text">
                <h2>风险与用量</h2>
                <p>提交前请确认这两项。</p>
              </div>
            </div>

            <div className="risk-block">
              <ShieldAlert size={17} aria-hidden="true" />
              <div>
                <strong>捐赠 key 可能被单独路由</strong>
                <p>
                  商家若识别出捐赠账号，可对其单独提供真模型。因此捐赠凭据的通过结果不会提升正式置信率，
                  只有失败结果会触发复核。
                </p>
              </div>
            </div>

            {projection && (
              <ul className="estimate-list">
                <li>
                  <span>单次检测成本</span>
                  <b>{formatUsd(projection.perPass)}</b>
                </li>
                <li>
                  <span>每天检测次数</span>
                  <b>{projection.passesPerDay.toFixed(1)}</b>
                </li>
                <li>
                  <span>预计耗尽时间</span>
                  <b>{formatDays(projection.days)}</b>
                </li>
              </ul>
            )}
            <p className="estimate-note">
              按中等强度预设（{PASS.requests} 请求）估算，实际用量随分组倍率与探针选择变化。
            </p>
          </aside>
        </div>
      )}

      {kind === 'vendor' && (
        <section className="card card-pad">
          <div className="step-head">
            <span className="step-num">1</span>
            <div>
              <h2>商家捐赠</h2>
              <p>走独立渠道，不在此页面收取凭据。</p>
            </div>
          </div>
          <p className="lead-note">
            商家提供的账号与数据会被单独标记为自报来源，<strong>不计入公开的综合置信率</strong>，
            也不能由商家自行批准与自己相关的变更。这是为了避免被检测方同时是评分方。
          </p>
          <div className="vendor-contact">
            <Mail size={18} aria-hidden="true" />
            <div>
              <strong>发起邮件确认</strong>
              <p>请从商家域名下的邮箱发起，我们会回复一份需要签署的范围与撤销条款。</p>
            </div>
            <Pill tone="info" size="sm">
              需邮件确认
            </Pill>
          </div>
        </section>
      )}
    </div>
  )
}
