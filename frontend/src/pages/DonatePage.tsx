import { Check, CloudCog, Eye, EyeOff, KeyRound, Mail, Network, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { RadioGroup } from 'radix-ui'
import { toast } from 'sonner'
import {
  ContributionApiError, fetchDonationStatus, quoteApiDonation, submitApiDonation,
  type DonationQuote, type DonationReceipt, type DonationStatus, type PreparedDonationSubmission,
} from '../api/contributions'
import { providerKindLabel } from '../data'
import { formatUsd } from '../pricing'
import { CheckField, FormSelect } from '../components/Fields'
import { PageHeader, Pill } from '../components/ui'

type DonationKind = 'proxy' | 'api' | 'vendor'

const kinds = [
  { id: 'proxy' as const, icon: Network, label: 'HTTP 代理', note: '最需要的一类' },
  { id: 'api' as const, icon: KeyRound, label: 'API 凭据', note: '真实周期检测' },
  { id: 'vendor' as const, icon: CloudCog, label: '商家捐赠', note: '特殊渠道，邮件确认' },
]

const phaseLabel: Record<string, string> = {
  queued: '等待验证', identity_probe: '正在验证凭据与分组', identity_probe_failed: '凭据验证失败',
  group_mismatch: '检测分组与所选分组不一致', testing: '正在执行模型检测', scheduling: '正在创建检测任务',
  active: '已激活，等待下一轮', model_unavailable: '模型不可用，等待重试', quota_exhausted: '额度不足，已暂停',
  registry_mismatch: '供应商配置已变化', scheduler_failed: '调度失败，等待重试',
}

function formatDays(days: number): string {
  if (!Number.isFinite(days)) return '无法估算'
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} 小时`
  if (days < 60) return `${days.toFixed(1)} 天`
  return `${(days / 30).toFixed(1)} 个月`
}

function errorText(error: unknown): string {
  if (error instanceof ContributionApiError) {
    return `${error.message}${error.code ? ` · ${error.code}` : ''}${error.requestId ? ` · 请求 ${error.requestId}` : ''}`
  }
  return error instanceof Error ? error.message : '请求失败'
}

export function DonatePage() {
  const [kind, setKind] = useState<DonationKind>('api')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [quota, setQuota] = useState(10)
  const [concurrency, setConcurrency] = useState(2)
  const [interval, setInterval] = useState(240)
  const [quote, setQuote] = useState<DonationQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [groupId, setGroupId] = useState('')
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<DonationReceipt | null>(null)
  const [status, setStatus] = useState<DonationStatus | null>(null)
  const pendingSubmission = useRef<{ fingerprint: string; idempotencyKey: string; prepared?: PreparedDonationSubmission } | null>(null)

  useEffect(() => {
    if (kind !== 'api' || !baseUrl.trim() || quota < 1 || concurrency < 1 || interval < 30) {
      setQuote(null); setQuoteError(null); setGroupId(''); return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setQuoteLoading(true); setQuoteError(null)
      void quoteApiDonation({ baseUrl: baseUrl.trim(), quotaUsd: quota, concurrency, intervalMinutes: interval, signal: controller.signal })
        .then((value) => {
          setQuote(value)
          setGroupId((current) => value.groups.some((group) => group.id === current) ? current : value.groups[0]?.id ?? '')
        })
        .catch((error) => {
          if (!controller.signal.aborted) { setQuote(null); setGroupId(''); setQuoteError(errorText(error)) }
        })
        .finally(() => { if (!controller.signal.aborted) setQuoteLoading(false) })
    }, 450)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [baseUrl, concurrency, interval, kind, quota])

  useEffect(() => {
    if (!receipt) return
    const controller = new AbortController()
    let timer = 0
    const poll = async () => {
      try { setStatus(await fetchDonationStatus(receipt.status_url, receipt.revocation_token, controller.signal)) }
      catch (error) { if (!controller.signal.aborted) toast.error(errorText(error)) }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 2000)
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [receipt])

  const selectedGroup = quote?.groups.find((group) => group.id === groupId) ?? null
  const projection = useMemo(() => {
    if (!selectedGroup || selectedGroup.estimated_cost_usd <= 0 || interval <= 0) return null
    const passesPerDay = 1440 / interval
    return { passesPerDay, days: quota / (selectedGroup.estimated_cost_usd * passesPerDay) }
  }, [interval, quota, selectedGroup])

  async function submitDonation() {
    if (!quote || !selectedGroup) return
    setSubmitting(true)
    try {
      const fingerprint = JSON.stringify({ baseUrl: baseUrl.trim(), apiKey, quota, concurrency, interval, groupId })
      if (pendingSubmission.current?.fingerprint !== fingerprint) {
        pendingSubmission.current = { fingerprint, idempotencyKey: crypto.randomUUID(), prepared: { quoteToken: quote.quote_token } }
      }
      const created = await submitApiDonation({
        baseUrl: baseUrl.trim(), apiKey, quotaUsd: quota, concurrency, intervalMinutes: interval, groupId,
        idempotencyKey: pendingSubmission.current.idempotencyKey, prepared: pendingSubmission.current.prepared,
      })
      pendingSubmission.current = null; setApiKey(''); setConsent(false); setReceipt(created)
      toast.success('凭据已进入自动验证队列')
    } catch (error) { toast.error(errorText(error)) }
    finally { setSubmitting(false) }
  }

  const progress = status?.progress_total ? Math.min(100, Math.round(status.progress_current / status.progress_total * 100)) : 0

  return (
    <div className="stack">
      <PageHeader title="捐赠节点" description="观测需要多样的出口网络与账号。凭据只在限定额度和频率内使用，随时可撤销。" />

      <RadioGroup.Root className="choice-grid choice-grid-3" value={kind} onValueChange={(value) => setKind(value as DonationKind)} aria-label="捐赠类型">
        {kinds.map(({ id, icon: Icon, label, note }) => (
          <RadioGroup.Item value={id} key={id} asChild>
            <button type="button" className={kind === id ? 'choice is-active' : 'choice'}>
              <span className="choice-icon"><Icon size={17} /></span>
              <span className="choice-text"><strong>{label}</strong><small>{note}</small></span>
              {kind === id && <Check size={16} />}
            </button>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>

      {kind === 'proxy' && (
        <section className="card card-pad">
          <div className="step-head"><span className="step-num">1</span><div><h2>捐赠 HTTP 代理</h2><p>代理捐赠仍通过单独通道审核。</p></div></div>
          <p className="lead-note">独立出口可以降低固定检测 IP 被识别并单独路由的风险。此入口暂不接收代理密码。</p>
          <div className="form-actions"><button type="button" className="btn btn-primary" disabled>暂未开放</button></div>
        </section>
      )}

      {kind === 'api' && (
        <div className="split">
          <section className="card card-pad">
            <div className="step-head"><span className="step-num">1</span><div><h2>捐赠 API 凭据</h2><p>服务器会自动归属供应商、验证分组并运行完整模型组。</p></div></div>
            <div className="field-grid">
              <label className="field is-full"><span>base_url</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} /></label>
              <label className="field is-full"><span>api_key</span><div className="secret"><KeyRound size={16} aria-hidden="true" /><input type={showKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="建议限额、限模型、可撤销" autoComplete="off" /><button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? '隐藏 api_key' : '显示 api_key'}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
              <label className="field"><span>额度上限（US$）</span><input type="number" min={1} max={10000} value={quota} onChange={(event) => setQuota(Number(event.target.value) || 0)} /></label>
              <label className="field"><span>并发限制</span><input type="number" min={1} max={16} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value) || 0)} /></label>
              <label className="field"><span>检测间隔（分钟）</span><input type="number" min={30} max={10080} value={interval} onChange={(event) => setInterval(Number(event.target.value) || 0)} /></label>
              <FormSelect label="检测分组" value={groupId} onValueChange={setGroupId} options={quote?.groups.map((group) => ({ value: group.id, label: `${group.name} · ${group.multiplier}x` })) ?? [{ value: 'waiting', label: quoteLoading ? '正在读取…' : '等待识别供应商' }]} />
            </div>

            <div className="detected-row">
              <span className="t-label">供应商归属</span>
              {quote ? <span>{providerKindLabel[quote.provider.kind]} · <strong>{quote.provider.name}</strong> · 精确域名匹配</span> : <span className={quoteError ? 'is-bad' : 't-faint'}>{quoteError ?? (quoteLoading ? '正在读取 registry…' : '填写 base_url 后自动读取')}</span>}
            </div>
            {selectedGroup && (
              <div className="donation-group-detail">
                <strong>{selectedGroup.name} · {selectedGroup.multiplier}x</strong>
                <span>{selectedGroup.models.length} 个模型，每个模型 {selectedGroup.requests_per_model} 个请求</span>
                <div className="model-chip-row">{selectedGroup.models.map((model) => <code key={model}>{model}</code>)}</div>
              </div>
            )}

            <CheckField checked={consent} onCheckedChange={setConsent}>我同意服务端在所列额度和频率内使用该凭据；凭据将加密保存，并可使用一次性撤销令牌撤销。</CheckField>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={!quote || !selectedGroup || !apiKey.trim() || !consent || submitting} onClick={() => void submitDonation()}>{submitting ? '提交中…' : '提交并开始验证'}</button>
              <span>撤销令牌仅在本次页面会话中显示</span>
            </div>

            {receipt && (
              <section className="donation-status" aria-live="polite">
                <div className="run-progress-head"><div><h2>{phaseLabel[status?.phase ?? 'queued'] ?? status?.phase ?? '等待状态'}</h2><p>{status?.current_model ? `当前模型 ${status.current_model}` : `捐赠 ${receipt.donation_id}`}</p></div><strong>{progress}%</strong></div>
                <progress max={100} value={progress}>{progress}%</progress>
                <div className="donation-status-grid">
                  <div><span>完成请求</span><b>{status?.progress_current ?? 0} / {status?.progress_total ?? (selectedGroup?.requests_per_model ?? 64) * (selectedGroup?.models.length ?? 1)}</b></div>
                  <div><span>分组归属</span><b>{status?.group_attribution === 'verified' ? '自动验证' : status?.group_attribution === 'donor_declared' ? '用户声明' : '待确认'}</b></div>
                  <div><span>已用额度</span><b>{formatUsd(status?.quota.spent_usd ?? 0)}</b></div>
                  <div><span>预留额度</span><b>{formatUsd(status?.quota.reserved_usd ?? 0)}</b></div>
                </div>
                {status?.errors && status.errors.length > 0 && <ul className="donation-errors">{status.errors.map((error, index) => <li key={`${error.at}-${error.code}-${index}`}><TriangleAlert size={15} /><span><strong>{error.model ? `${error.model} · ` : ''}{error.code}</strong><small>{error.message}{error.http_status ? ` · HTTP ${error.http_status}` : ''} · {error.retryable ? '将自动重试' : '需要检查配置或权限'}</small></span></li>)}</ul>}
                <div className="revocation-token"><span>撤销令牌</span><code>{receipt.revocation_token}</code></div>
              </section>
            )}
          </section>

          <aside className="card split-aside">
            <div className="card-head"><div className="card-head-text"><h2>风险与用量</h2><p>以 registry 中的实际模型组估算。</p></div></div>
            <div className="risk-block"><ShieldAlert size={17} aria-hidden="true" /><div><strong>捐赠 key 可能被单独路由</strong><p>检测结果会保留自动验证或用户声明归属，同时单独展示网络可用率。</p></div></div>
            {selectedGroup && <ul className="estimate-list"><li><span>每轮预计成本</span><b>{formatUsd(selectedGroup.estimated_cost_usd)}</b></li><li><span>每轮最高预留</span><b>{formatUsd(selectedGroup.maximum_cost_usd)}</b></li><li><span>每天检测轮数</span><b>{projection?.passesPerDay.toFixed(1) ?? '—'}</b></li><li><span>预计可持续</span><b>{projection ? formatDays(projection.days) : '—'}</b></li></ul>}
            <p className="estimate-note">运行前预留整轮最高成本，完成后按上游 usage 结算；没有 usage 时使用保守估算。</p>
          </aside>
        </div>
      )}

      {kind === 'vendor' && (
        <section className="card card-pad"><div className="step-head"><span className="step-num">1</span><div><h2>商家捐赠</h2><p>走独立渠道，不在此页面收取凭据。</p></div></div><p className="lead-note">商家提供的数据单独标记为自报来源，不计入公开综合真实性通过率。</p><div className="vendor-contact"><Mail size={18} aria-hidden="true" /><div><strong>发起邮件确认</strong><p>请从商家域名邮箱发起，我们会回复范围与撤销条款。</p></div><Pill tone="info" size="sm">需邮件确认</Pill></div>
        </section>
      )}
    </div>
  )
}
