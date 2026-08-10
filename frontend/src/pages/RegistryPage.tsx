import { ExternalLink, Lock, PencilLine, Shuffle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PROBE_ISSUE_TEMPLATE, REPO_URL } from '../config'
import {
  JUICE_EFFORTS,
  JUICE_SIGNATURES,
  categoryLabel,
  probes,
} from '../probes'
import type { ProbeDefinition } from '../probes'
import { fetchRegistry } from '../api/publicData'
import { createRegistryProposal } from '../api/contributions'
import { FormSelect } from '../components/Fields'
import { PageHeader, Pill } from '../components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui-kit/dialog'

/* Builds a prefilled GitHub issue. The frontend never talks to the GitHub API —
 * it hands off a structured body that a bot can parse into a PR. */
function buildIssueUrl(probe: ProbeDefinition, field: string, proposed: string, reason: string) {
  const body = [
    '<!-- 由模型数据库编辑器生成，请勿删除下方代码块 -->',
    '',
    '```yaml',
    `probe_id: ${probe.id}`,
    `field: ${field}`,
    `current: ${JSON.stringify(field === 'expectedAnswer' ? probe.expectedAnswer ?? '' : probe.label)}`,
    `proposed: ${JSON.stringify(proposed)}`,
    '```',
    '',
    '### 变更理由',
    '',
    reason || '（未填写）',
  ].join('\n')

  const params = new URLSearchParams({
    template: PROBE_ISSUE_TEMPLATE,
    title: `probe(${probe.id}): 修改 ${field}`,
    body,
  })
  return `${REPO_URL}/issues/new?${params.toString()}`
}

function JuiceSignatureTable() {
  const models = Object.keys(JUICE_SIGNATURES)
  return (
    <div className="table-scroll">
      <table className="signature-table">
        <caption className="sr-only">各模型在各强度下的 Juice 常量</caption>
        <thead>
          <tr>
            <th scope="col">模型</th>
            {JUICE_EFFORTS.map((effort) => (
              <th scope="col" key={effort}>
                {effort}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model}>
              <th scope="row">{model}</th>
              {JUICE_EFFORTS.map((effort) => {
                const value = JUICE_SIGNATURES[model][effort]
                const isSolHigh = model === 'gpt-5.6-sol' && effort === 'high'
                return (
                  <td key={effort} className={isSolHigh ? 'is-flagged' : undefined}>
                    {value ?? '—'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EditDialog({ probe }: { probe: ProbeDefinition }) {
  const editableFields = probe.promptPinned
    ? [{ value: 'label', label: '显示名称' }, { value: 'scoringNote', label: '评分说明' }]
    : [
        { value: 'label', label: '显示名称' },
        { value: 'promptTemplate', label: '提示词' },
        { value: 'expectedAnswer', label: '预期答案' },
        { value: 'scoringNote', label: '评分说明' },
      ]

  const [field, setField] = useState(editableFields[0].value)
  const [proposed, setProposed] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const currentValue = field === 'expectedAnswer'
    ? probe.expectedAnswer ?? ''
    : field === 'promptTemplate'
      ? probe.promptTemplate
      : field === 'scoringNote'
        ? probe.scoringNote ?? ''
        : probe.label
  const apiField = field === 'expectedAnswer'
    ? 'expected_answer' as const
    : field === 'promptTemplate'
      ? 'prompt_template' as const
      : field === 'scoringNote'
        ? 'scoring_note' as const
        : 'label' as const

  async function submitProposal() {
    const fallback = buildIssueUrl(probe, field, proposed, reason)
    const popup = window.open('about:blank', '_blank')
    if (popup) popup.opener = null
    setSubmitting(true)
    try {
      const created = await createRegistryProposal({
        probeId: probe.id, field: apiField, currentValue, proposedValue: proposed, reason,
      })
      if (popup) popup.location.href = created.issue_url
      else window.location.href = created.issue_url
      toast.info('提案已登记，正在打开 GitHub issue')
    } catch {
      if (popup) popup.location.href = fallback
      else window.location.href = fallback
      toast.warning('后端不可用，已改用未登记的 GitHub issue 草稿')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="btn btn-sm">
          <PencilLine size={14} /> 提交修改
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改 {probe.label}</DialogTitle>
          <DialogDescription>
            提交后会打开一个预填的 GitHub issue，正文包含机器可读的变更块，由 bot 解析建 PR。
          </DialogDescription>
        </DialogHeader>

        {probe.promptPinned && (
          <p className="inline-lock">
            <Lock size={14} aria-hidden="true" />
            此探针的提示词受 SHA-256 锁定，改写会使已校准的基线失效，因此不可编辑。
          </p>
        )}

        <div className="field-grid">
          <FormSelect
            label="修改字段"
            value={field}
            onValueChange={setField}
            options={editableFields}
            full
          />
          <label className="field is-full">
            <span>建议值</span>
            <textarea rows={3} value={proposed} onChange={(event) => setProposed(event.target.value)} />
          </label>
          <label className="field is-full">
            <span>变更理由与证据</span>
            <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
        </div>

        <DialogFooter>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!proposed.trim() || reason.trim().length < 20 || submitting}
            onClick={() => void submitProposal()}
          >
            <ExternalLink size={15} /> {submitting ? '登记中…' : '登记并打开 issue'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RegistryPage() {
  const [visibleProbes, setVisibleProbes] = useState(probes)
  const [selectedId, setSelectedId] = useState(probes[0].id)
  useEffect(() => {
    const controller = new AbortController()
    fetchRegistry(controller.signal)
      .then((response) => {
        if (!response.items.length) return
        const updated = response.items.flatMap((item) => {
          const existing = probes.find((probe) => probe.id === item.id)
          if (!existing) return []
          return [{
            ...existing,
            category: item.category,
            promptTemplate: item.prompt_template,
            ...(item.developer_message ? { developerMessage: item.developer_message } : {}),
            promptPinned: !item.prompt_rewrite_allowed,
          }]
        })
        if (updated.length) setVisibleProbes(updated)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])
  const selected = useMemo(
    () => visibleProbes.find((probe) => probe.id === selectedId) ?? visibleProbes[0],
    [selectedId, visibleProbes],
  )

  return (
    <div className="stack">
      <PageHeader
        title="模型数据库"
        description="平台使用的全部探针、随机化规则与预期答案。提示词与基线一一对应，改写提示词即使基线失效。"
      />

      <div className="registry-layout">
        <section className="card">
          <ul className="probe-list">
            {visibleProbes.map((probe) => (
              <li key={probe.id}>
                <button
                  type="button"
                  className={probe.id === selectedId ? 'probe-row is-active' : 'probe-row'}
                  onClick={() => setSelectedId(probe.id)}
                  aria-current={probe.id === selectedId}
                >
                  <span className="probe-row-main">
                    <strong>{probe.label}</strong>
                    <code>{probe.id}</code>
                  </span>
                  <span className="probe-row-meta">{categoryLabel[probe.category]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card probe-detail">
          <div className="card-head">
            <div className="card-head-text">
              <h2>{selected.label}</h2>
              <p>
                {categoryLabel[selected.category]} · <code>{selected.id}</code>
              </p>
            </div>
            <EditDialog probe={selected} />
          </div>

          <div className="probe-section">
            <span className="t-label">提示词</span>
            {selected.developerMessage && (
              <pre className="prompt-block is-developer">
                <span className="prompt-role">developer</span>
                {selected.developerMessage}
              </pre>
            )}
            <pre className="prompt-block">
              <span className="prompt-role">user</span>
              {selected.promptTemplate}
            </pre>
            {selected.promptPinned && (
              <p className="inline-lock">
                <Lock size={14} aria-hidden="true" />
                提示词受 SHA-256 锁定，不可改写
              </p>
            )}
          </div>

          {selected.randomizedPart && (
            <div className="probe-section">
              <span className="t-label">随机部分</span>
              <p className="random-rule">
                <Shuffle size={15} aria-hidden="true" />
                <code>{selected.randomizedPart.placeholder}</code>
                <span>{selected.randomizedPart.description}</span>
              </p>
              <p className="t-faint">示例：{selected.randomizedPart.example}</p>
            </div>
          )}

          <div className="probe-section">
            <span className="t-label">预期答案</span>
            {selected.answerKind === 'exact' && (
              <p className="expected-answer">
                <code>{selected.expectedAnswer}</code>
                <Pill tone="good" size="sm">
                  唯一正确答案
                </Pill>
              </p>
            )}
            {selected.answerKind === 'distribution' && (
              <p className="expected-answer">
                <Pill tone="info" size="sm">
                  按分布评分
                </Pill>
              </p>
            )}
            {selected.answerKind === 'signature' && <JuiceSignatureTable />}
            {selected.scoringNote && <p className="scoring-note">{selected.scoringNote}</p>}
          </div>

          {selected.hardAnomalyRule && (
            <div className="probe-section">
              <span className="t-label">硬异常判定</span>
              <p className="anomaly-rule">{selected.hardAnomalyRule}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
