import { CheckCircle2, Download, Eye, EyeOff, KeyRound, Loader2, Play, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { RUNNER_DOWNLOAD_URL } from '../config'
import { detectLocalRunner, supportsNativeFormat } from '../lib/localRunner'
import type { RunnerState } from '../lib/localRunner'
import { estimateRun, presets } from '../probes'
import type { RunConfig } from '../probes'
import { DEFAULT_MULTIPLIER, DEFAULT_PRICE } from '../pricing'
import type { PriceAssumption } from '../pricing'
import { ProbeSelector } from '../components/ProbeSelector'
import { RunEstimate } from '../components/RunEstimate'
import { PageHeader, Pill } from '../components/ui'
import { CheckField } from '../components/Fields'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui-kit/dialog'

export function PrivateCheckPage() {
  const [runner, setRunner] = useState<RunnerState>({ status: 'checking' })
  const [baseUrl, setBaseUrl] = useState('https://api.example.com/v1')
  const [model, setModel] = useState('gpt-5.6-sol')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [config, setConfig] = useState<RunConfig>(() => structuredClone(presets[0].config))
  const [price, setPrice] = useState<PriceAssumption>(DEFAULT_PRICE)
  const [multiplier, setMultiplier] = useState(DEFAULT_MULTIPLIER)
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false)
  const [remoteConsent, setRemoteConsent] = useState(false)

  useEffect(() => {
    let cancelled = false
    detectLocalRunner().then((state) => {
      if (!cancelled) setRunner(state)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const nativeAvailable = supportsNativeFormat(runner)
  const remote = runner.status === 'remote'
  const canRun = runner.status === 'present' || remote

  const ready = useMemo(
    () => Boolean(baseUrl.trim() && model.trim() && apiKey.trim() && config.probes.length && canRun),
    [apiKey, baseUrl, canRun, config.probes.length, model],
  )

  function recheck() {
    setRunner({ status: 'checking' })
    detectLocalRunner().then(setRunner)
  }

  function acceptRemote() {
    setRunner({ status: 'remote' })
    setRemoteDialogOpen(false)
    setRemoteConsent(false)
    // Native replay cannot run remotely; drop it rather than silently failing.
    setConfig((current) => ({
      ...current,
      formats: current.formats.filter((format) => format !== 'native_codex').length
        ? current.formats.filter((format) => format !== 'native_codex')
        : ['normal'],
    }))
    toast.warning('已切换到项目服务器代理', {
      description: 'API key 将随请求发送到项目服务器。Native Codex 格式不可用。',
    })
  }

  function startRun() {
    if (!ready) return
    const estimate = estimateRun(config)
    toast.info('这是交互原型，未发出任何请求', {
      description: `将执行 ${estimate.requests} 个请求，单次检测，不做持续监控。`,
    })
  }

  return (
    <div className="stack">
      <PageHeader
        title="私有检测"
        description="使用你自己的凭据发起一次性检测。优先在本机执行，凭据不经过项目服务器。"
        actions={<Pill size="sm">单次检测</Pill>}
      />

      {/* Execution location is the first thing the page settles, because it
          decides whether the key leaves the machine at all. */}
      {runner.status === 'checking' && (
        <div className="runner-bar">
          <Loader2 className="spin" size={17} aria-hidden="true" />
          正在检测本机执行器…
        </div>
      )}

      {runner.status === 'present' && (
        <div className="runner-bar is-local">
          <CheckCircle2 size={17} aria-hidden="true" />
          <span>
            已检测到本机执行器 <code>v{runner.version}</code>，检测将完全在本机执行，API key 不出本机。
          </span>
        </div>
      )}

      {runner.status === 'remote' && (
        <div className="runner-bar is-remote">
          <span>
            当前使用项目服务器代理。API key、探针请求与目标返回都会经过项目服务器；Native Codex 不可用。
          </span>
          <button type="button" className="btn btn-sm" onClick={recheck}>
            <RefreshCw size={14} /> 改回本机
          </button>
        </div>
      )}

      {runner.status === 'absent' && (
        <section className="notice notice-warn runner-absent">
          <div className="notice-body">
            <strong>未检测到本机执行器</strong>
            <p>
              本机执行器让 API key 留在你自己的机器上，也是运行 Native Codex 格式的唯一方式——原生格式需要自行建立
              TCP/TLS 连接并复刻字节级请求，浏览器做不到。
            </p>
          </div>
          <div className="runner-actions">
            <a className="btn btn-primary" href={RUNNER_DOWNLOAD_URL} target="_blank" rel="noreferrer">
              <Download size={16} /> 下载本机执行器
            </a>
            <button type="button" className="btn btn-sm" onClick={recheck}>
              <RefreshCw size={14} /> 重新检测
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setRemoteDialogOpen(true)}
            >
              改用项目服务器代理（不推荐）
            </button>
          </div>
        </section>
      )}

      <div className="split">
        <div className="stack-tight">
          <section className="card card-pad">
            <div className="step-head">
              <span className="step-num">0</span>
              <div>
                <h2>目标与凭据</h2>
                <p>请使用短期、限额、可撤销的 key。</p>
              </div>
            </div>
            <div className="field-grid">
              <label className="field is-full">
                <span>base_url</span>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>测试模型</span>
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>api_key</span>
                <div className="secret">
                  <KeyRound size={16} aria-hidden="true" />
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="仅保存在内存"
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
            </div>
          </section>

          <ProbeSelector config={config} onChange={setConfig} nativeAvailable={nativeAvailable} />

          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={!ready} onClick={startRun}>
              <Play size={16} /> 开始检测
            </button>
            {!canRun && <span>需要本机执行器，或显式改用项目服务器代理。</span>}
            {canRun && !config.probes.length && <span>请至少选择一个检测项。</span>}
          </div>
        </div>

        <RunEstimate
          config={config}
          price={price}
          multiplier={multiplier}
          remote={remote}
          onPriceChange={setPrice}
          onMultiplierChange={setMultiplier}
        />
      </div>

      {/* The one and only warning, gating the transition into remote mode —
          not repeated per request. */}
      <Dialog open={remoteDialogOpen} onOpenChange={setRemoteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>凭据将发送到项目服务器</DialogTitle>
            <DialogDescription>
              改用项目服务器代理后，你填写的 base_url、api_key、探针请求与目标 API 返回都会发送到项目服务器，由服务器代为发起请求。
            </DialogDescription>
          </DialogHeader>
          <ul className="policy-list">
            <li>只应使用短期、限额、限定模型、可撤销的 key。</li>
            <li>Native Codex 格式在此模式下不可用，选中的话会被移除。</li>
            <li>安装本机执行器可以完全避免这一步。</li>
          </ul>
          <CheckField checked={remoteConsent} onCheckedChange={setRemoteConsent}>
            我已理解上述数据流，并确认使用的是短期、限额、可撤销的 key。
          </CheckField>
          <DialogFooter>
            <button type="button" className="btn" onClick={() => setRemoteDialogOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!remoteConsent}
              onClick={acceptRemote}
            >
              确认使用服务器代理
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
