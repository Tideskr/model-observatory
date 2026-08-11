import { createHash, createHmac } from 'node:crypto'
import type { ProbeId } from '../contracts/private-runs.js'
import type { RunRecord } from '../store/run-store.js'
import type { ScoringProbeSeed, ScoringReleaseSeed } from '../scoring/types.js'

export interface ProbeJob {
  jobId: string
  probeId: ProbeId
  profile: 'normal+no_history'
  effort: string
  messages: { role: 'developer' | 'user'; content: string }[]
  expectedValue: string | null
  syntheticValue: number | null
  cacheKey: string
}

function probeMap(seed: ScoringReleaseSeed): Map<string, ScoringProbeSeed> {
  return new Map(seed.probes.map((probe) => [probe.probeId, probe]))
}

function effort(probeId: string, probe: ScoringProbeSeed): string {
  if (probeId.startsWith('juice_') && probeId !== 'juice_coverage') return probeId.slice('juice_'.length)
  if (probeId === 'juice_coverage' || probeId.startsWith('output_')) return 'high'
  const baseline = probe.metadata['baseline']
  return baseline != null && typeof baseline === 'object'
    ? String((baseline as Record<string, unknown>)['effort'] ?? 'low')
    : 'low'
}

function derivedBytes(run: RunRecord, label: string): Buffer {
  return createHmac('sha256', run.requestDigest).update('model-observatory:run-job:').update(label).digest()
}

function syntheticValue(run: RunRecord, probe: ScoringProbeSeed, repeat: number): number {
  const rules = probe.metadata['synthetic_value_rules'] as Record<string, unknown> | undefined
  const range = Array.isArray(rules?.['integer_range']) ? rules['integer_range'].map(Number) : [10_000, 99_999]
  const excluded = new Set(Array.isArray(rules?.['excluded_values']) ? rules['excluded_values'].map(Number) : [])
  const prefixes = Array.isArray(rules?.['excluded_decimal_prefixes']) ? rules['excluded_decimal_prefixes'].map(String) : []
  const minimum = range[0] ?? 10_000
  const size = (range[1] ?? 99_999) - minimum + 1
  for (let counter = 0; ; counter += 1) {
    const value = minimum + (derivedBytes(run, `synthetic:${repeat}:${counter}`).readUInt32BE(0) % size)
    if (!excluded.has(value) && !prefixes.some((prefix) => String(value).startsWith(prefix))) return value
  }
}

function renderMessages(
  probeId: ProbeId,
  probe: ScoringProbeSeed,
  template: string,
  run: RunRecord,
  repeat: number,
): { messages: ProbeJob['messages']; expectedValue: string | null; synthetic: number | null } {
  const nonce = derivedBytes(run, `nonce:${probeId}:${repeat}`).subarray(0, 6).toString('hex')
  if (probeId === 'juice_coverage') {
    const synthetic = syntheticValue(run, probe, repeat)
    return {
      messages: [
        { role: 'developer', content: probe.developerPrompt.replaceAll('{synthetic_value}', String(synthetic)) },
        { role: 'user', content: probe.prompt.replaceAll('{synthetic_value}', String(synthetic)) },
      ],
      expectedValue: String(synthetic),
      synthetic,
    }
  }
  const messages: ProbeJob['messages'] = []
  if (probe.developerPrompt) messages.push({ role: 'developer', content: probe.developerPrompt })
  messages.push({ role: 'user', content: template.replaceAll('{nonce}', nonce) })
  const expected = probe.metadata['expected']
  return { messages, expectedValue: typeof expected === 'string' ? expected : null, synthetic: null }
}

export function buildRunJobs(run: RunRecord, seed: ScoringReleaseSeed): ProbeJob[] {
  const probes = probeMap(seed)
  const jobs: ProbeJob[] = []
  for (const selection of run.config.probes) {
    const probe = probes.get(selection.probe_id)
    if (!probe) throw new Error(`scoring release is missing probe ${selection.probe_id}`)
    const templates = seed.templates.filter((item) => item.probeId === selection.probe_id)
    for (let repeat = 0; repeat < selection.requests; repeat += 1) {
      const template = templates.length ? templates[repeat % templates.length]!.prompt : probe.prompt
      const rendered = renderMessages(selection.probe_id, probe, template, run, repeat)
      const cacheKey = derivedBytes(run, `cache:${selection.probe_id}:${repeat}`).subarray(0, 16).toString('hex')
      const manifest = {
        runId: run.id,
        probeId: selection.probe_id,
        profile: 'normal+no_history',
        repeat,
      }
      jobs.push({
        jobId: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
        probeId: selection.probe_id,
        profile: 'normal+no_history',
        effort: effort(selection.probe_id, probe),
        messages: rendered.messages,
        expectedValue: rendered.expectedValue,
        syntheticValue: rendered.synthetic,
        cacheKey,
      })
    }
  }
  return jobs
}
