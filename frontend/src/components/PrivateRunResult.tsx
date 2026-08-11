import { Download } from 'lucide-react'
import type { PrivateRunReport, PrivateRunStatus } from '../api/privateRuns'
import { Pill } from './ui'

export interface PrivateRunProgress {
  status: PrivateRunStatus
  phase: string
  completed: number
  total: number
  successful: number
  errors: number
  cancelled: number
  pending: number
  inFlight: number
  httpAttempts: number
  retries: number
}

const statusLabels: Record<PrivateRunStatus, string> = {
  queued: '排队中',
  provisioning: '准备中',
  running: '执行探针',
  scoring: '生成报告',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timed_out: '超时',
  incomplete: '部分完成',
  deleted: '已删除',
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function text(value: unknown, fallback = '—'): string {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.length) return value.map((item) => text(item, '')).filter(Boolean).join('、')
  return fallback
}

function boolText(value: unknown): string {
  return value === true ? '是' : value === false ? '否' : '—'
}

function fingerprintStatusText(value: unknown): string {
  if (value === 'strong_match') return '强匹配'
  if (value === 'unclear') return '证据不明确'
  return text(value)
}

function statusTone(status: PrivateRunStatus): 'good' | 'warn' | 'bad' | 'info' {
  if (status === 'completed') return 'good'
  if (['failed', 'timed_out'].includes(status)) return 'bad'
  if (['cancelled', 'incomplete'].includes(status)) return 'warn'
  return 'info'
}

function percent(value: unknown): string {
  const numeric = number(value, Number.NaN)
  if (!Number.isFinite(numeric)) return '—'
  return `${(numeric <= 1 ? numeric * 100 : numeric).toFixed(1)}%`
}

function downloadReport(report: PrivateRunReport) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `model-observatory-report-${report.run_id}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

export function RunProgress({ runId, progress }: { runId: string; progress: PrivateRunProgress }) {
  const ratio = progress.total > 0 ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : 0
  return (
    <div className="run-progress" aria-live="polite">
      <div className="run-progress-head">
        <div>
          <h2>{statusLabels[progress.status]}</h2>
          <p><code>{runId}</code></p>
        </div>
        <strong>{ratio}%</strong>
      </div>
      <progress max={Math.max(1, progress.total)} value={progress.completed} aria-label="检测进度" />
      <div className="run-metrics">
        <div><span>完成</span><b>{progress.completed} / {progress.total}</b></div>
        <div><span>成功</span><b>{progress.successful}</b></div>
        <div><span>失败</span><b>{progress.errors}</b></div>
        <div><span>执行中</span><b>{progress.inFlight}</b></div>
        <div><span>HTTP 尝试</span><b>{progress.httpAttempts}</b></div>
        <div><span>重试</span><b>{progress.retries}</b></div>
      </div>
    </div>
  )
}

export function PrivateRunResult({ report }: { report: PrivateRunReport }) {
  const summary = report.summary
  const network = record(summary['network_summary'])
  const juice = record(summary['juice_summary'])
  const output = record(summary['output_integrity'] ?? summary['output_integrity_summary'])
  const coverage = record(summary['coverage'] ?? summary['coverage_summary'])
  const probability = record(summary['probability'])
  const fingerprint = record(summary['fingerprint_summary'])
  const reliability = record(probability['empirical_reliability'] ?? fingerprint['empirical_reliability'])
  const profiles = record(summary['profile_summary'])
  const perEffort = record(juice['per_effort'])
  const errorSummary = Array.isArray(summary['error_summary']) ? summary['error_summary'] : []
  const probabilities = record(probability['conditional_relative_probability'] ?? fingerprint['fingerprint_match'])
  const limitations = Array.isArray(summary['limitations']) ? summary['limitations'] : []
  const errorDetail = record(summary['error_detail'])
  const completed = number(summary['completed_requests'], number(network['logical_completed'], report.observations.length))
  const successful = number(summary['successful_requests'], number(network['successful'], completed - number(summary['failed_requests'])))
  const failed = number(summary['failed_requests'], number(network['final_errors']))
  const retries = number(summary['retries'], number(network['retries']))
  const verdict = text(summary['title_cn'] ?? summary['overall_verdict'], '无可用结论')
  const subtitle = text(summary['subtitle_cn'], '')
  const fingerprintStatus = fingerprint['fingerprint_status'] ?? probability['fingerprint_status']
  const fingerprintStrong = fingerprintStatus === 'strong_match'
  const fingerprintModel = fingerprintStrong ? text(fingerprint['fingerprint_model'] ?? probability['fingerprint_model']) : '—'
  const reliabilityAvailable = reliability['calibration_available'] === true
  const reliabilitySummary = reliabilityAvailable
    ? `${number(reliability['correct'])} / ${number(reliability['selected'])}`
    : fingerprintStrong ? '暂无同范围校准数据' : '不适用'

  return (
    <div className="run-report">
      <header className="run-report-head">
        <div>
          <div className="run-report-title-row">
            <h2>{verdict}</h2>
            <Pill tone={statusTone(report.status)} size="sm">{statusLabels[report.status]}</Pill>
          </div>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button type="button" className="btn btn-icon" title="下载 JSON 报告" aria-label="下载 JSON 报告" onClick={() => downloadReport(report)}>
          <Download size={17} />
        </button>
      </header>

      <dl className="report-metadata">
        <div><dt>目标模型</dt><dd>{report.target.model}</dd></div>
        <div><dt>目标地址</dt><dd>{report.target.origin}</dd></div>
        <div><dt>评分版本</dt><dd>{report.scoring_release_id}</dd></div>
        <div><dt>报告时间</dt><dd>{new Date(report.created_at).toLocaleString()}</dd></div>
      </dl>

      <section className="report-section" aria-labelledby="execution-summary">
        <h3 id="execution-summary">执行摘要</h3>
        <div className="run-metrics is-report">
          <div><span>已完成</span><b>{completed}</b></div>
          <div><span>成功</span><b>{successful}</b></div>
          <div><span>失败</span><b>{failed}</b></div>
          <div><span>取消</span><b>{number(summary['cancelled_requests'], number(network['cancelled']))}</b></div>
          <div><span>HTTP 尝试</span><b>{number(summary['http_attempts'], number(network['http_attempts'], completed))}</b></div>
          <div><span>重试</span><b>{retries}</b></div>
        </div>
      </section>

      {(Object.keys(errorDetail).length > 0 || Boolean(summary['safe_error'])) && (
        <section className="report-section report-error" aria-labelledby="report-error-detail">
          <h3 id="report-error-detail">失败详情</h3>
          <dl className="evidence-grid">
            <div><dt>阶段</dt><dd>{text(errorDetail['stage'])}</dd></div>
            <div><dt>错误码</dt><dd>{text(errorDetail['code'] ?? summary['safe_error'])}</dd></div>
            <div><dt>HTTP 状态</dt><dd>{text(errorDetail['status_code'])}</dd></div>
            <div><dt>可重试</dt><dd>{boolText(errorDetail['retryable'])}</dd></div>
            <div className="is-full"><dt>详细信息</dt><dd>{text(errorDetail['message'] ?? summary['subtitle_cn'])}</dd></div>
          </dl>
        </section>
      )}

      {errorSummary.length > 0 && (
        <section className="report-section report-error" aria-labelledby="report-error-summary">
          <h3 id="report-error-summary">错误汇总</h3>
          <div className="table-scroll">
            <table className="report-table">
              <thead><tr><th>错误码</th><th>HTTP</th><th>可重试</th><th>请求数</th><th>尝试数</th><th>脱敏详情</th></tr></thead>
              <tbody>
                {errorSummary.map((raw, index) => {
                  const item = record(raw)
                  return <tr key={`${text(item['code'] ?? item['category'])}-${index}`}><th>{text(item['code'] ?? item['category'])}</th><td>{text(item['http_status'])}</td><td>{boolText(item['retryable'])}</td><td>{number(item['count'], 1)}</td><td>{number(item['attempts'], number(item['count'], 1))}</td><td>{text(item['message'] ?? item['safe_message'])}</td></tr>
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="report-section" aria-labelledby="evidence-summary">
        <h3 id="evidence-summary">证据摘要</h3>
        <dl className="evidence-grid">
          <div><dt>Juice 状态</dt><dd>{text(juice['state'])}</dd></div>
          <div><dt>申报型号命中</dt><dd>{number(juice['current_success'])}</dd></div>
          <div><dt>混用命中</dt><dd>{number(juice['mixed'])}</dd></div>
          <div><dt>混用型号</dt><dd>{text(juice['mixed_models_observed'])}</dd></div>
          <div><dt>输出硬异常</dt><dd>{boolText(output['hard_anomaly'])}</dd></div>
          <div><dt>覆盖硬异常</dt><dd>{boolText(coverage['hard_anomaly'])}</dd></div>
          <div><dt>指纹状态</dt><dd>{fingerprintStatusText(fingerprintStatus ?? (probability['enabled'] ? '已启用' : '未启用'))}</dd></div>
          <div><dt>指纹指向</dt><dd>{fingerprintModel}</dd></div>
          <div><dt>实测可靠度</dt><dd>{reliabilitySummary}</dd></div>
        </dl>
      </section>

      {Object.keys(perEffort).length > 0 && (
        <section className="report-section" aria-labelledby="juice-detail">
          <h3 id="juice-detail">Juice 分档</h3>
          <div className="table-scroll">
            <table className="report-table">
              <thead><tr><th>档位</th><th>尝试</th><th>有效</th><th>申报型号</th><th>混用</th><th>无效</th><th>网络错误</th></tr></thead>
              <tbody>
                {Object.entries(perEffort).map(([effort, raw]) => {
                  const item = record(raw)
                  return <tr key={effort}><th>{effort}</th><td>{number(item['attempted'])}</td><td>{number(item['valid_completed'])}</td><td>{number(item['current_success'])}</td><td>{number(item['mixed'])}</td><td>{number(item['unsuccessful'])}</td><td>{number(item['network_error'])}</td></tr>
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {Object.keys(probabilities).length > 0 && (
        <section className="report-section" aria-labelledby="fingerprint-detail">
          <h3 id="fingerprint-detail">模型相对匹配</h3>
          <div className="probability-list">
            {Object.entries(probabilities).sort(([, left], [, right]) => number(right) - number(left)).map(([name, value]) => (
              <div key={name}><span>{name}</span><progress max={1} value={Math.min(1, number(value))} /><b>{percent(value)}</b></div>
            ))}
          </div>
        </section>
      )}

      {reliabilityAvailable && (
        <section className="report-section" aria-labelledby="empirical-reliability">
          <h3 id="empirical-reliability">实测可靠度</h3>
          <dl className="evidence-grid">
            <div><dt>观察精度</dt><dd>{percent(reliability['observed_precision'])}</dd></div>
            <div><dt>判对 / 样本</dt><dd>{reliabilitySummary}</dd></div>
            <div><dt>95% Wilson 区间</dt><dd>{percent(reliability['wilson95_lower'])} - {percent(reliability['wilson95_upper'])}</dd></div>
            <div><dt>门禁覆盖率</dt><dd>{percent(reliability['coverage'])}</dd></div>
            <div><dt>校准范围</dt><dd>{text(reliability['tier'])} / {text(reliability['predicted_model'])}</dd></div>
            <div><dt>匹配门槛</dt><dd>{text(reliability['threshold_operator'])} {percent(reliability['threshold'])}</dd></div>
            <div className="is-full"><dt>校准版本</dt><dd>{text(reliability['calibration_id'])}</dd></div>
          </dl>
        </section>
      )}

      {Object.keys(profiles).length > 0 && (
        <section className="report-section" aria-labelledby="profile-detail">
          <h3 id="profile-detail">请求 Profile</h3>
          <div className="table-scroll">
            <table className="report-table">
              <thead><tr><th>Profile</th><th>任务</th><th>成功</th><th>失败</th><th>取消</th></tr></thead>
              <tbody>
                {Object.entries(profiles).map(([profile, raw]) => {
                  const item = record(raw)
                  return <tr key={profile}><th>{profile}</th><td>{number(item['logical_tasks'])}</td><td>{number(item['successful'])}</td><td>{number(item['final_errors'])}</td><td>{number(item['cancelled'])}</td></tr>
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="report-section" aria-labelledby="observation-detail">
        <h3 id="observation-detail">脱敏观测 <span>{report.observations.length}</span></h3>
        <div className="table-scroll">
          <table className="report-table observations-table">
            <thead><tr><th>#</th><th>探针</th><th>Profile</th><th>状态</th><th>分类 / 结果</th><th>耗时</th><th>尝试</th><th>HTTP</th><th>可重试</th><th>错误码</th><th>脱敏详情</th></tr></thead>
            <tbody>
              {report.observations.map((observation, index) => {
                const safeError = record(observation['safe_error'])
                return (
                  <tr key={text(observation['job_id'], String(index))}>
                    <td>{index + 1}</td>
                    <th>{text(observation['probe_id'])}</th>
                    <td>{text(observation['profile'])}</td>
                    <td>{text(observation['status'])}</td>
                    <td>{text(observation['normalized_value'] ?? observation['classification'] ?? observation['category'])}</td>
                    <td>{typeof observation['elapsed_ms'] === 'number' ? `${observation['elapsed_ms']} ms` : '—'}</td>
                    <td>{number(observation['attempts_sent'], 1)}</td>
                    <td>{text(observation['http_status'] ?? safeError['http_status'])}</td>
                    <td>{boolText(observation['retryable'] ?? safeError['retryable'])}</td>
                    <td>{text(safeError['category'] ?? observation['safe_error'])}</td>
                    <td>{text(observation['safe_message'] ?? safeError['safe_message'])}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {limitations.length > 0 && (
        <section className="report-section" aria-labelledby="report-limitations">
          <h3 id="report-limitations">结论边界</h3>
          <ul className="report-limitations">{limitations.map((item, index) => <li key={index}>{text(item)}</li>)}</ul>
        </section>
      )}

      <details className="raw-report">
        <summary>原始脱敏 JSON</summary>
        <pre>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </div>
  )
}
