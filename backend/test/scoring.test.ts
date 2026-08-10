import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { buildRunJobs } from '../src/executor/job-plan.js'
import { importLegacyScoringRelease } from '../src/scoring/legacy-import.js'
import { scoreRun, type RawObservation } from '../src/scoring/score.js'
import type { RunRecord } from '../src/store/run-store.js'

test('medium preset uses the exact Legacy calibration and produces a formal probability result', async () => {
  const root = resolve(process.cwd(), '..', 'Legacy', 'gpt56_vnext', 'baselines')
  const seed = await importLegacyScoringRelease(resolve(root, 'runtime_catalog.json'), resolve(root, 'trusted_likelihood_v2.json'))
  const run: RunRecord = {
    id: randomUUID(), quoteId: randomUUID(), requestDigest: 'd'.repeat(64), status: 'running',
    targetOrigin: 'https://api.example.com', targetBaseUrl: 'https://api.example.com/v1', targetHostname: 'api.example.com',
    model: 'gpt-5.6-sol',
    config: {
      probes: [
        { probe_id: 'juice_high', requests: 12 }, { probe_id: 'juice_low', requests: 6 },
        { probe_id: 'juice_xhigh', requests: 6 }, { probe_id: 'juice_max', requests: 6 },
        { probe_id: 'output_luna_48', requests: 1 }, { probe_id: 'output_terra_32', requests: 1 },
        { probe_id: 'juice_coverage', requests: 2 }, { probe_id: 'rand_country', requests: 20 },
        { probe_id: 'b80_letter_count', requests: 10 },
      ],
      formats: ['normal'], contexts: ['no_history'], workers: 8, retries: 0,
    },
    disclosureVersion: 'remote-normal-v1', scoringReleaseId: seed.id, ownerTokenHash: 'a'.repeat(64),
    idempotencyKey: 'medium-scoring-test-key', credentialHandle: randomUUID(),
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const jobs = buildRunJobs(run, seed)
  const categoryAnswers = new Map<string, string[]>()
  for (const probeId of ['rand_country', 'b80_letter_count']) {
    const cell = seed.cells.find((item) => item.probeId === probeId && item.profile === 'normal+no_history')!
    const models = cell.rawCounts['models'] as Record<string, { windows: Record<string, { counts: Record<string, number> }> }>
    const values = Object.values(models['gpt-5.6-sol']!.windows).flatMap((window) =>
      Object.entries(window.counts).flatMap(([category, count]) => Array.from({ length: count }, () => category)),
    )
    categoryAnswers.set(probeId, values)
  }
  const counters = new Map<string, number>()
  const signatures: Record<string, string> = { low: '8', high: '40', xhigh: '128', max: '960' }
  const rows: RawObservation[] = jobs.map((job) => {
    const index = counters.get(job.probeId) ?? 0
    counters.set(job.probeId, index + 1)
    let answer: string
    if (job.probeId === 'rand_country') answer = categoryAnswers.get(job.probeId)![index]!
    else if (job.probeId === 'b80_letter_count') answer = categoryAnswers.get(job.probeId)![index] === 'exact_3' ? '3' : '2'
    else if (job.probeId === 'juice_coverage') answer = String(job.syntheticValue)
    else if (job.probeId === 'output_luna_48') answer = '48'
    else if (job.probeId === 'output_terra_32') answer = '32'
    else answer = signatures[job.effort]!
    return { job, status: 'ok', answer, elapsedMs: 1 }
  })
  const result = scoreRun(run, rows, seed)
  const probability = result.summary['probability'] as Record<string, unknown>
  assert.equal(result.status, 'completed')
  assert.equal(probability['formal_eligible'], true)
  assert.equal(probability['winner'], 'gpt-5.6-sol')
  assert.equal(probability['probability_pass'], true)
  assert.equal(result.summary['overall_verdict'], '通过')
})
