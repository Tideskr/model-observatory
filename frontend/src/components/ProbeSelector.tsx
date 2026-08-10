import { useMemo } from 'react'
import { Checkbox } from './ui-kit/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui-kit/tooltip'
import { contextLabel, formatLabel, matchPreset, presets } from '../probes'
import type { ContextMode, RequestFormat, RunConfig } from '../probes'

/* The brief's checkbox list mixes two axes: WHAT to test (probe families) and
 * HOW to run it (transport format, context length, concurrency). Splitting
 * them into two cards keeps this from becoming one undifferentiated wall of
 * checkboxes, which is what made the previous version hard to read. */

interface SelectionItem {
  key: string
  label: string
  probeIds: string[]
  defaultRequests: number
  advanced?: boolean
}

interface SelectionGroup {
  label: string
  items: SelectionItem[]
}

const SELECTION_GROUPS: SelectionGroup[] = [
  {
    label: 'Juice 指纹',
    items: [
      { key: 'juice_high', label: '高强度', probeIds: ['juice_high'], defaultRequests: 8 },
      { key: 'juice_low', label: '低强度', probeIds: ['juice_low'], defaultRequests: 4 },
      { key: 'juice_medium', label: '中强度', probeIds: ['juice_medium'], defaultRequests: 4, advanced: true },
      { key: 'juice_xhigh', label: '超高强度', probeIds: ['juice_xhigh'], defaultRequests: 4, advanced: true },
      { key: 'juice_max', label: '最高强度', probeIds: ['juice_max'], defaultRequests: 4, advanced: true },
    ],
  },
  {
    label: '输出与覆盖',
    items: [
      {
        key: 'output_integrity',
        label: '输出完整性 32/48',
        probeIds: ['output_luna_48', 'output_terra_32'],
        defaultRequests: 1,
      },
      { key: 'juice_coverage', label: '简单提示覆盖', probeIds: ['juice_coverage'], defaultRequests: 2 },
    ],
  },
  {
    label: '分布指纹',
    items: [
      { key: 'rand_country', label: '国家分布', probeIds: ['rand_country'], defaultRequests: 10 },
      { key: 'b80_letter_count', label: 'B80 字符题', probeIds: ['b80_letter_count'], defaultRequests: 10 },
      { key: 'rand_bird', label: '鸟类分布', probeIds: ['rand_bird'], defaultRequests: 10, advanced: true },
    ],
  },
]

const ALL_ITEMS = SELECTION_GROUPS.flatMap((group) => group.items)

function isSelected(config: RunConfig, item: SelectionItem) {
  return item.probeIds.every((id) => config.probes.some((probe) => probe.probeId === id))
}

export function ProbeSelector({
  config,
  onChange,
  nativeAvailable,
}: {
  config: RunConfig
  onChange: (config: RunConfig) => void
  nativeAvailable: boolean
}) {
  const activePreset = useMemo(() => matchPreset(config), [config])
  const allSelected = ALL_ITEMS.every((item) => isSelected(config, item))

  function toggleItem(item: SelectionItem, checked: boolean) {
    const without = config.probes.filter((probe) => !item.probeIds.includes(probe.probeId))
    onChange({
      ...config,
      probes: checked
        ? [...without, ...item.probeIds.map((id) => ({ probeId: id, requests: item.defaultRequests }))]
        : without,
    })
  }

  function toggleAll(checked: boolean) {
    onChange({
      ...config,
      probes: checked
        ? ALL_ITEMS.flatMap((item) =>
            item.probeIds.map((id) => ({ probeId: id, requests: item.defaultRequests })),
          )
        : [],
    })
  }

  function toggleFormat(format: RequestFormat, checked: boolean) {
    const next = checked
      ? [...config.formats, format]
      : config.formats.filter((value) => value !== format)
    if (!next.length) return
    onChange({ ...config, formats: next })
  }

  function toggleContext(context: ContextMode, checked: boolean) {
    const next = checked
      ? [...config.contexts, context]
      : config.contexts.filter((value) => value !== context)
    if (!next.length) return
    onChange({ ...config, contexts: next })
  }

  return (
    <>
      <div className="preset-row" role="group" aria-label="预设">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={activePreset === preset.id ? 'preset-chip is-active' : 'preset-chip'}
            onClick={() => onChange(structuredClone(preset.config))}
          >
            {preset.label}
          </button>
        ))}
        <span className={activePreset === 'custom' ? 'preset-chip is-custom' : 'preset-chip is-muted'}>
          自定义
        </span>
        <span className="preset-note">
          {activePreset === 'custom'
            ? '已偏离内置预设，结果仅供参考'
            : '内置预设，与归档检测器参数一致'}
        </span>
      </div>

      <section className="card card-pad">
        <div className="step-head">
          <span className="step-num">1</span>
          <div>
            <h2>检测内容</h2>
            <p>选择要运行的探针族。</p>
          </div>
        </div>

        {SELECTION_GROUPS.map((group) => {
          const advanced = group.items.filter((item) => item.advanced)
          const primary = group.items.filter((item) => !item.advanced)

          return (
            <div className="probe-group" key={group.label}>
              <span className="probe-group-label">{group.label}</span>
              <div className="probe-options">
                {primary.map((item) => (
                  <label className="probe-option" key={item.key}>
                    <Checkbox
                      checked={isSelected(config, item)}
                      disabled={allSelected}
                      onCheckedChange={(state) => toggleItem(item, state === true)}
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
                {advanced.length > 0 && (
                  <details className="probe-more">
                    <summary>更多</summary>
                    <div className="probe-options">
                      {advanced.map((item) => (
                        <label className="probe-option" key={item.key}>
                          <Checkbox
                            checked={isSelected(config, item)}
                            disabled={allSelected}
                            onCheckedChange={(state) => toggleItem(item, state === true)}
                          />
                          <span>{item.label}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          )
        })}

        <label className="probe-option is-all">
          <Checkbox checked={allSelected} onCheckedChange={(state) => toggleAll(state === true)} />
          <span>全部内置探针</span>
        </label>
      </section>

      <section className="card card-pad">
        <div className="step-head">
          <span className="step-num">2</span>
          <div>
            <h2>运行方式</h2>
            <p>格式与上下文可多选，实际请求数为两者的组合。</p>
          </div>
        </div>

        <div className="probe-group">
          <span className="probe-group-label">请求格式</span>
          <div className="probe-options">
            <label className="probe-option">
              <Checkbox
                checked={config.formats.includes('normal')}
                onCheckedChange={(state) => toggleFormat('normal', state === true)}
              />
              <span>{formatLabel.normal}</span>
            </label>
            {nativeAvailable ? (
              <label className="probe-option">
                <Checkbox
                  checked={config.formats.includes('native_codex')}
                  onCheckedChange={(state) => toggleFormat('native_codex', state === true)}
                />
                <span>{formatLabel.native_codex}</span>
              </label>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="probe-option is-disabled">
                    <Checkbox checked={false} disabled />
                    <span>{formatLabel.native_codex}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  需本机执行器：原生格式要复刻字节级请求并自行建立 TCP/TLS 连接，浏览器无法完成。
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="probe-group">
          <span className="probe-group-label">上下文</span>
          <div className="probe-options">
            {(['no_history', 'fixed_32k_history'] as ContextMode[]).map((context) => (
              <label className="probe-option" key={context}>
                <Checkbox
                  checked={config.contexts.includes(context)}
                  onCheckedChange={(state) => toggleContext(context, state === true)}
                />
                <span>{contextLabel[context]}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="field-grid">
          <label className="field">
            <span>并发数（1–32）</span>
            <input
              type="number"
              min={1}
              max={32}
              value={config.workers}
              onChange={(event) =>
                onChange({
                  ...config,
                  workers: Math.min(32, Math.max(1, Number(event.target.value) || 1)),
                })
              }
            />
          </label>
          <label className="field">
            <span>重试次数（0–2）</span>
            <input
              type="number"
              min={0}
              max={2}
              value={config.retries}
              onChange={(event) =>
                onChange({
                  ...config,
                  retries: Math.min(2, Math.max(0, Number(event.target.value) || 0)),
                })
              }
            />
          </label>
        </div>

        <details className="probe-advanced">
          <summary>高级：按探针精确设置请求次数</summary>
          <div className="request-grid">
            {config.probes.map((probe) => (
              <label className="field" key={probe.probeId}>
                <span>{probe.probeId}</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={probe.requests}
                  onChange={(event) =>
                    onChange({
                      ...config,
                      probes: config.probes.map((item) =>
                        item.probeId === probe.probeId
                          ? { ...item, requests: Math.max(1, Number(event.target.value) || 1) }
                          : item,
                      ),
                    })
                  }
                />
              </label>
            ))}
            {config.probes.length === 0 && <p className="t-faint">尚未选择任何探针。</p>}
          </div>
        </details>
      </section>
    </>
  )
}
