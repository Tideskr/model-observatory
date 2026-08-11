import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createProviderRegistry, parseProviderRegistry } from '../src/registry/catalog.js'
import { importScoringRelease, defaultScoringReleaseManifest } from '../src/scoring/release-import.js'
import { createMemoryServices } from '../src/services.js'
import { AppError } from '../src/errors.js'
import type { DonationRecord } from '../src/store/contribution-store.js'
import { RunWorker } from '../src/worker/run-worker.js'
import { DonationScheduler } from '../src/worker/donation-scheduler.js'

const config = loadConfig({
  APP_ENV: 'test', TOKEN_PEPPER: 'donation-monitor-token-pepper-123456789',
  QUOTE_SIGNING_SECRET: 'donation-monitor-quote-secret-12345678',
  CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 17).toString('base64'),
})

const registry = createProviderRegistry(parseProviderRegistry({
  schema_version: 2,
  pricing: { input_per_million_usd: 1.25, output_per_million_usd: 10 },
  providers: [{
    slug: 'example', name: 'Example Relay', kind: 'relay',
    group_detection: { probe_model: '__group_probe__' },
    groups: [{ id: 'standard', name: 'Standard', aliases: ['标准分组'], multiplier: 0.2, models: ['gpt-5.6-sol'] }],
    domains: [{ hostname: 'api.example.com', role: 'primary', default_base_path: '/v1', status: 'active' }],
  }],
}))

async function donationRecord(services: ReturnType<typeof createMemoryServices>): Promise<DonationRecord> {
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000)
  const credentialHandle = await services.credentialVault.put('donation-test-secret', `donation:${id}`, expiresAt)
  return {
    id, quoteId: randomUUID(), requestDigest: createHash('sha256').update(id).digest('hex'),
    idempotencyKey: `donation-test:${id}`, kind: 'api', status: 'quarantined',
    targetOrigin: 'https://api.example.com', targetBaseUrl: 'https://api.example.com/v1', targetHostname: 'api.example.com',
    providerSlug: 'example', groupId: 'standard', detectedGroupId: null, groupAttribution: 'pending',
    phase: 'queued', progressCurrent: 0, progressTotal: 64, currentModel: null,
    nextRunAt: new Date().toISOString(), lastCheckedAt: null, quotaSpentUsd: 0, quotaReservedUsd: 0, errors: [],
    constraints: { quota_usd: 100, concurrency: 4, interval_minutes: 240, expires_in_days: 1 },
    credentialHandle, credentialFingerprintTail: '0123456789', revocationTokenHash: createHash('sha256').update(`revoke:${id}`).digest('hex'),
    disclosureVersion: 'donation-api-v1', createdAt: new Date().toISOString(), expiresAt: expiresAt.toISOString(), revokedAt: null,
  }
}

test('registry validation enforces globally unique exact hostnames', () => {
  assert.equal(registry.findByHostname('API.EXAMPLE.COM.')?.slug, 'example')
  assert.equal(registry.findByHostname('sub.api.example.com'), null)
  assert.throws(() => parseProviderRegistry({
    schema_version: 2, pricing: { input_per_million_usd: 1, output_per_million_usd: 1 },
    providers: [
      { slug: 'one', name: 'One', kind: 'relay', group_detection: { probe_model: 'missing' }, groups: [], domains: [{ hostname: 'same.example', role: 'primary', default_base_path: '/v1', status: 'active' }] },
      { slug: 'two', name: 'Two', kind: 'relay', group_detection: { probe_model: 'missing' }, groups: [], domains: [{ hostname: 'same.example', role: 'primary', default_base_path: '/v1', status: 'active' }] },
    ],
  }), /assigned more than once/)
})

test('donated credentials schedule a full medium run and activate after valid evidence', async () => {
  const services = createMemoryServices(config, registry)
  const record = await donationRecord(services)
  await services.contributionStore.createDonation(record)
  const scheduler = new DonationScheduler({
    config, services, workerId: 'donation-scheduler-test',
    identityProbe: async () => ({ detectedGroupId: 'standard', attribution: 'verified', catalogModels: ['gpt-5.6-sol'], errors: [] }),
  })
  assert.equal(await scheduler.scheduleOnce(), true)
  const pending = await services.contributionStore.listPendingDonationRuns()
  assert.equal(pending.length, 1)
  const seed = await importScoringRelease(defaultScoringReleaseManifest())
  const signatures: Record<string, string> = { low: '8', high: '40', xhigh: '128', max: '960' }
  const worker = new RunWorker({
    services, loadScoringRelease: async () => seed,
    donationRequestIntervalMs: 0,
    transport: async (input) => {
      const prompt = input.messages.map((item) => item.content).join('\n')
      const synthetic = /J U I C E=(\d+)/.exec(prompt)?.[1]
      const answer = synthetic ?? (prompt.includes('digits 48') ? '48' : prompt.includes('digits 32') ? '32' : prompt.includes('strawberry') ? '3' : prompt.includes('random country') ? 'Canada' : signatures[input.effort] ?? '40')
      return { answer, elapsedMs: 3, statusCode: 200, eventCount: 1 }
    },
  })
  assert.equal(await worker.runOnce(), true)
  assert.equal(await scheduler.reconcileOnce(), true)
  const completedRuns = await services.contributionStore.listDonationCycleRuns(pending[0]!.cycleId)
  assert.equal(completedRuns.length, 1)
  assert.ok(completedRuns[0]!.modelProbability != null)
  assert.ok(completedRuns[0]!.modelProbability! >= 0 && completedRuns[0]!.modelProbability! <= 1)
  const active = await services.contributionStore.getDonation(record.id)
  assert.equal(active?.status, 'active')
  assert.equal(active?.phase, 'active')
  assert.equal(active?.groupAttribution, 'verified')
  assert.equal(active?.progressCurrent, 64)
  assert.ok((active?.quotaSpentUsd ?? 0) > 0)
  await services.close()
})

test('revocation fences an already claimed donation before cycle creation', async () => {
  const services = createMemoryServices(config, registry)
  const record = await donationRecord(services)
  await services.contributionStore.createDonation(record)
  const claimed = await services.contributionStore.claimDueDonation('revocation-race-worker', 60)
  assert.ok(claimed)

  await services.contributionStore.revokeDonation(record.id, new Date().toISOString())
  await assert.rejects(
    () => services.contributionStore.createDonationCycle({
      id: randomUUID(), donationId: record.id, status: 'running', attribution: 'verified',
      reservedCostUsd: 1, actualCostUsd: 0, createdAt: new Date().toISOString(), completedAt: null,
    }, [], 'revocation-race-worker'),
    (error: unknown) => error instanceof AppError && error.code === 'donation_lease_lost',
  )
  assert.equal((await services.contributionStore.listPendingDonationRuns()).length, 0)
  assert.equal(await services.contributionStore.claimDueDonation('another-worker', 60), null)
  await services.close()
})
