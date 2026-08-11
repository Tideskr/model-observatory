import { Clock3, Coins, Hash, ShieldAlert } from 'lucide-react'
import { estimateRun } from '../probes'
import type { RunConfig } from '../probes'
import { estimateCost, estimateMaximumRunCost, formatUsd } from '../pricing'
import type { PriceAssumption } from '../pricing'
import { Pill } from './ui'
import type { Tone } from '../scales'

/* Estimates, not measurements. Request count is exact (ported from the
 * archived preset arithmetic); wall time and token counts are approximations
 * and are labelled as such rather than presented as facts. */

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`
  return `${(value / 1_000_000).toFixed(2)}M`
}

function riskOf(config: RunConfig, remote: boolean): { tone: Tone; label: string; note: string } {
  if (remote) {
    return {
      tone: 'bad',
      label: '高',
      note: 'API key 与目标返回都会经过项目服务器。',
    }
  }
  if (config.contexts.includes('fixed_32k_history')) {
    return {
      tone: 'warn',
      label: '中',
      note: '含固定 32K 上下文，单请求输入约 33,792 token，费用显著上升。',
    }
  }
  return {
    tone: 'good',
    label: '低',
    note: '仅短上下文请求，全部在本机执行。',
  }
}

export function RunEstimate({
  config,
  price,
  multiplier,
  remote,
  onPriceChange,
  onMultiplierChange,
}: {
  config: RunConfig
  price: PriceAssumption
  multiplier: number
  remote: boolean
  onPriceChange: (price: PriceAssumption) => void
  onMultiplierChange: (multiplier: number) => void
}) {
  const estimate = estimateRun(config)
  const cost = estimateCost(estimate.inputTokens, estimate.outputTokens, price, multiplier)
  const maximumAttempts = estimate.requests * (config.retries + 1)
  const maximumCost = estimateMaximumRunCost(estimate, config.retries, price, multiplier)
  const risk = riskOf(config, remote)

  return (
    <aside className="card split-aside">
      <div className="card-head">
        <div className="card-head-text">
          <h2>本次检测预计</h2>
          <p>请求数为精确值，其余为估算。</p>
        </div>
      </div>

      <ul className="estimate-list">
        <li>
          <ShieldAlert size={16} aria-hidden="true" />
          <span>风险</span>
          <Pill tone={risk.tone} size="sm" dot>
            {risk.label}
          </Pill>
        </li>
        <li>
          <Hash size={16} aria-hidden="true" />
          <span>请求数</span>
          <b>{estimate.requests}</b>
        </li>
        <li>
          <Hash size={16} aria-hidden="true" />
          <span>最大调用</span>
          <b>{maximumAttempts}</b>
        </li>
        <li>
          <Clock3 size={16} aria-hidden="true" />
          <span>预计用时</span>
          <b>{formatDuration(estimate.seconds)}</b>
        </li>
        <li>
          <Hash size={16} aria-hidden="true" />
          <span>预计 token</span>
          <b>
            {formatTokens(estimate.inputTokens)} 入 / {formatTokens(estimate.outputTokens)} 出
          </b>
        </li>
        <li>
          <Coins size={16} aria-hidden="true" />
          <span>预计 / 上限</span>
          <b>{formatUsd(cost)} / {formatUsd(maximumCost)}</b>
        </li>
      </ul>

      <p className="estimate-note">{risk.note}</p>

      <details className="estimate-assumptions">
        <summary>价格假设</summary>
        <p className="t-faint">
          项目未维护价格表，以下为可编辑假设。中转分组倍率按你所用分组填写。
        </p>
        <div className="field-grid">
          <label className="field">
            <span>输入 US$ / 1M</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={price.inputPerMillion}
              onChange={(event) =>
                onPriceChange({ ...price, inputPerMillion: Number(event.target.value) || 0 })
              }
            />
          </label>
          <label className="field">
            <span>输出 US$ / 1M</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={price.outputPerMillion}
              onChange={(event) =>
                onPriceChange({ ...price, outputPerMillion: Number(event.target.value) || 0 })
              }
            />
          </label>
          <label className="field is-full">
            <span>分组倍率</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={multiplier}
              onChange={(event) => onMultiplierChange(Number(event.target.value) || 0)}
            />
          </label>
        </div>
      </details>
    </aside>
  )
}
