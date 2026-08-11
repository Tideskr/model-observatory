import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig } from '../src/config.js'
import { buildRunJobs } from '../src/executor/job-plan.js'
import { TransportError } from '../src/executor/normal-transport.js'
import { defaultScoringReleaseManifest, importScoringRelease } from '../src/scoring/release-import.js'
import { scoreObservation } from '../src/scoring/score.js'
import { createMemoryServices } from '../src/services.js'
import { LeaseLostError, type RunRecord } from '../src/store/run-store.js'
import { RunWorker } from '../src/worker/run-worker.js'

const workerConfig = loadConfig({
  APP_ENV: 'test',
  TOKEN_PEPPER: 'worker-test-token-pepper-123456789012',
  QUOTE_SIGNING_SECRET: 'worker-test-quote-secret-12345678901',
  CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 11).toString('base64'),
})

test('worker executes, scores, persists a sanitized report, and destroys the credential', async () => {
  const services = createMemoryServices(workerConfig)
  const seed = await importScoringRelease(defaultScoringReleaseManifest())
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
    leaseVersion: 0,
  }
  await services.runStore.create(run)
  assert.deepEqual(buildRunJobs(run, seed), buildRunJobs(run, seed))
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
  assert.equal(report?.summary['overall_verdict'], 'Juice通过；指纹证据不明确')
  assert.equal(report?.observations.length, 14)
  assert.equal(JSON.stringify(report).includes(secret), false)
  await assert.rejects(() => services.credentialVault.read(credentialHandle))
  await services.close()
})

test('worker retry attempts are durably bounded per job', async () => {
  const services = createMemoryServices(workerConfig)
  const seed = await importScoringRelease(defaultScoringReleaseManifest())
  const expiresAt = new Date(Date.now() + 60_000)
  const credentialHandle = await services.credentialVault.put('retry-test-secret', 'quote-retry', expiresAt)
  const run: RunRecord = {
    id: randomUUID(), quoteId: randomUUID(), requestDigest: 'e'.repeat(64), status: 'queued',
    targetOrigin: 'https://api.example.com', targetBaseUrl: 'https://api.example.com/v1', targetHostname: 'api.example.com',
    model: 'gpt-5.6-sol',
    config: {
      probes: [{ probe_id: 'output_luna_48', requests: 1 }], formats: ['normal'], contexts: ['no_history'],
      workers: 1, retries: 2,
    },
    disclosureVersion: 'remote-normal-v1', scoringReleaseId: seed.id, ownerTokenHash: 'b'.repeat(64),
    idempotencyKey: 'worker-retry-budget-test', credentialHandle, createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(), leaseVersion: 0,
  }
  await services.runStore.create(run)
  let attempts = 0
  const worker = new RunWorker({
    services,
    loadScoringRelease: async () => seed,
    transport: async () => {
      attempts += 1
      throw new TransportError('connection_or_tls_error', true)
    },
  })
  assert.equal(await worker.runOnce(), true)
  assert.equal(attempts, 3)
  assert.equal((await services.runStore.get(run.id))?.status, 'failed')
  const report = await services.runStore.getReport(run.id)
  assert.equal(report?.observations[0]?.['safe_error'], 'connection_or_tls_error')
  assert.equal(report?.observations[0]?.['attempts_sent'], 3)
  assert.equal(report?.summary['retries'], 2)
  assert.equal(report?.summary['completed_requests'], 1)
  assert.equal(report?.summary['successful_requests'], 0)
  assert.deepEqual(report?.summary['error_summary'], [{
    code: 'connection_or_tls_error',
    message: 'The worker could not connect to the target or establish trusted TLS.',
    http_status: null,
    retryable: true,
    count: 1,
    attempts: 3,
  }])
  const events = await services.runStore.listEvents(run.id, '0')
  const progress = events.filter((event) => event.eventType === 'progress').at(-1)?.payload
  assert.equal(progress?.['errors'], 1)
  assert.equal(progress?.['retries'], 2)
  await services.close()
})

test('expired leases fence old workers and recovery skips checkpointed observations', async () => {
  const services = createMemoryServices(workerConfig)
  const seed = await importScoringRelease(defaultScoringReleaseManifest())
  const expiresAt = new Date(Date.now() + 60_000)
  const credentialHandle = await services.credentialVault.put('recovery-test-secret', 'quote-recovery', expiresAt)
  const run: RunRecord = {
    id: randomUUID(), quoteId: randomUUID(), requestDigest: 'f'.repeat(64), status: 'queued',
    targetOrigin: 'https://api.example.com', targetBaseUrl: 'https://api.example.com/v1', targetHostname: 'api.example.com',
    model: 'gpt-5.6-sol',
    config: {
      probes: [{ probe_id: 'output_luna_48', requests: 1 }], formats: ['normal'], contexts: ['no_history'],
      workers: 1, retries: 0,
    },
    disclosureVersion: 'remote-normal-v1', scoringReleaseId: seed.id, ownerTokenHash: 'c'.repeat(64),
    idempotencyKey: 'worker-recovery-test', credentialHandle, createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(), leaseVersion: 0,
  }
  await services.runStore.create(run)
  const first = await services.runStore.claimNext('worker-old', 0.5)
  assert.ok(first)
  const firstLease = { workerId: 'worker-old', version: first.leaseVersion }
  const job = buildRunJobs(run, seed)[0]!
  await services.runStore.saveObservations(
    run.id,
    [scoreObservation(run, { job, status: 'ok', answer: '48', elapsedMs: 1 }, seed)],
    firstLease,
  )
  await delay(550)
  const second = await services.runStore.claimNext('worker-new', 0.5)
  assert.ok(second)
  assert.equal(second.leaseVersion, first.leaseVersion + 1)
  await assert.rejects(
    () => services.runStore.transition(run.id, 'running', 'started', {}, firstLease),
    LeaseLostError,
  )

  let requests = 0
  const worker = new RunWorker({
    services,
    workerId: 'worker-recovery',
    loadScoringRelease: async () => seed,
    transport: async () => {
      requests += 1
      return { answer: '48', elapsedMs: 1, statusCode: 200, eventCount: 1 }
    },
  })
  await delay(550)
  assert.equal(await worker.runOnce(), true)
  assert.equal(requests, 0)
  assert.equal((await services.runStore.get(run.id))?.status, 'completed')
  await services.close()
})
