import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { importLegacyScoringRelease } from '../src/scoring/legacy-import.js'
import { createMemoryServices } from '../src/services.js'
import type { RunRecord } from '../src/store/run-store.js'
import { RunWorker } from '../src/worker/run-worker.js'

const workerConfig = loadConfig({
  APP_ENV: 'test',
  TOKEN_PEPPER: 'worker-test-token-pepper-123456789012',
  QUOTE_SIGNING_SECRET: 'worker-test-quote-secret-12345678901',
  CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 11).toString('base64'),
})

test('worker executes, scores, persists a sanitized report, and destroys the credential', async () => {
  const services = createMemoryServices(workerConfig)
  const root = resolve(process.cwd(), '..', 'Legacy', 'gpt56_vnext', 'baselines')
  const seed = await importLegacyScoringRelease(resolve(root, 'runtime_catalog.json'), resolve(root, 'trusted_likelihood_v2.json'))
  const expiresAt = new Date(Date.now() + 60_000)
  const secret = 'secret-key-that-must-not-enter-the-report'
  const credentialHandle = await services.credentialVault.put(secret, 'quote-test', expiresAt)
  const run: RunRecord = {
    id: randomUUID(),
    quoteId: randomUUID(),
    requestDigest: 'd'.repeat(64),
    status: 'queued',
    targetOrigin: 'https://api.example.com',
    targetBaseUrl: 'https://api.example.com/v1',
    targetHostname: 'api.example.com',
    model: 'gpt-5.6-sol',
    config: {
      probes: [
        { probe_id: 'juice_high', requests: 8 },
        { probe_id: 'juice_low', requests: 3 },
        { probe_id: 'output_luna_48', requests: 1 },
        { probe_id: 'output_terra_32', requests: 1 },
        { probe_id: 'juice_coverage', requests: 1 },
      ],
      formats: ['normal'],
      contexts: ['no_history'],
      workers: 8,
      retries: 0,
    },
    disclosureVersion: 'remote-normal-v1',
    scoringReleaseId: seed.id,
    ownerTokenHash: 'a'.repeat(64),
    idempotencyKey: 'worker-test-idempotency-key',
    credentialHandle,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
  await services.runStore.create(run)
  const signatures: Record<string, string> = { low: '8', high: '40' }
  const worker = new RunWorker({
    services,
    loadScoringRelease: async () => seed,
    transport: async (input) => {
      assert.equal(input.apiKey, secret)
      const prompt = input.messages.map((item) => item.content).join('\n')
      const synthetic = /J U I C E=(\d+)/.exec(prompt)?.[1]
      const answer = synthetic ?? (prompt.includes('digits 48') ? '48' : prompt.includes('digits 32') ? '32' : signatures[input.effort] ?? '40')
      return { answer, elapsedMs: 4, statusCode: 200, eventCount: 2 }
    },
  })
  assert.equal(await worker.runOnce(), true)
  assert.equal((await services.runStore.get(run.id))?.status, 'completed')
  const report = await services.runStore.getReport(run.id)
  assert.equal(report?.summary['overall_verdict'], '通过')
  assert.equal(report?.observations.length, 14)
  assert.equal(JSON.stringify(report).includes(secret), false)
  await assert.rejects(() => services.credentialVault.read(credentialHandle))
  await services.close()
})
