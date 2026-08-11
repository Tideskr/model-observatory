import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import type { ProbeId } from '../src/contracts/private-runs.js'
import type { ProbeJob } from '../src/executor/job-plan.js'
import { defaultScoringReleaseManifest, importScoringRelease } from '../src/scoring/release-import.js'
import { scoreObservation } from '../src/scoring/score.js'
import type { RunRecord } from '../src/store/run-store.js'

interface JuiceCase {
  claimed_model: string
  effort: string
  answer: string
  normalized_value: string | null
  classification: string
  mixed_models: string[]
}

test('TypeScript scoring matches the shared juice conformance cases', async () => {
  const seed = await importScoringRelease(defaultScoringReleaseManifest())
  const fixturePath = resolve(defaultScoringReleaseManifest(), '..', 'conformance.json')
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { juice_cases: JuiceCase[] }
  for (const [index, item] of fixture.juice_cases.entries()) {
    const run = {
      id: crypto.randomUUID(), quoteId: crypto.randomUUID(), requestDigest: 'a'.repeat(64), status: 'running',
      targetOrigin: 'https://api.example.com', targetBaseUrl: 'https://api.example.com/v1', targetHostname: 'api.example.com',
      model: item.claimed_model, config: { probes: [], formats: ['normal'], contexts: ['no_history'], workers: 1, retries: 0 },
      disclosureVersion: 'remote-normal-v1', scoringReleaseId: seed.id, ownerTokenHash: 'b'.repeat(64),
      idempotencyKey: `conformance-${index}`, credentialHandle: crypto.randomUUID(), createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), leaseVersion: 0,
    } as RunRecord
    const job: ProbeJob = {
      jobId: `job-${index}`,
      probeId: `juice_${item.effort}` as ProbeId,
      profile: 'normal+no_history',
      effort: item.effort,
      messages: [],
      expectedValue: null,
      syntheticValue: null,
      cacheKey: `case-${index}`,
    }
    const result = scoreObservation(run, { job, status: 'ok', answer: item.answer }, seed)
    assert.equal(result.normalizedValue, item.normalized_value, `normalized value for case ${index}`)
    assert.equal(result.classification, item.classification, `classification for case ${index}`)
    assert.deepEqual(result.metadata['mixed_models'] ?? [], item.mixed_models, `mixed models for case ${index}`)
  }
})
