import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApp } from '../src/app.js'
import type { PublicRegistryItem } from '../src/contracts/public.js'
import { DONATION_DISCLOSURE_VERSION } from '../src/contracts/contributions.js'
import { loadConfig } from '../src/config.js'
import { createMemoryServices } from '../src/services.js'
import { MemoryPublicRepository } from '../src/store/public-repository.js'
import { createProviderRegistry, parseProviderRegistry } from '../src/registry/catalog.js'

const config = loadConfig({
  APP_ENV: 'test',
  ENABLE_API_DOCS: 'false',
  TOKEN_PEPPER: 'contribution-test-token-pepper-123456789',
  QUOTE_SIGNING_SECRET: 'contribution-test-quote-secret-12345678',
  CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 13).toString('base64'),
  REPOSITORY_URL: 'https://github.com/example/model-observatory',
})

const pinnedProbe: PublicRegistryItem = {
  id: 'juice_high',
  category: 'signature',
  prompt_template: 'Return the calibrated Juice signature.',
  prompt_sha256: 'a'.repeat(64),
  scoring_kind: 'signature',
  prompt_rewrite_allowed: false,
  status: 'stable',
  metadata: {},
}

const providerRegistry = createProviderRegistry(parseProviderRegistry({
  schema_version: 2,
  pricing: { input_per_million_usd: 1.25, output_per_million_usd: 10 },
  providers: [{
    slug: 'example', name: 'Example', kind: 'relay',
    domains: [{ hostname: 'api.example.com', role: 'primary', default_base_path: '/v1', status: 'active' }],
    group_detection: { probe_model: '__group_probe__' },
    groups: [{ id: 'default', name: 'Default', aliases: [], multiplier: 1, models: ['gpt-5.6-sol'] }],
  }],
}))

test('API donation is quarantined, capability-protected, and destroys its credential on revoke', async (context) => {
  const services = createMemoryServices(config, providerRegistry)
  const app = await buildApp({ config, services, logger: false })
  context.after(() => app.close())

  const quoteResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/donations/quote',
    payload: {
      kind: 'api',
      base_url: 'api.example.com/v1',
      constraints: { quota_usd: 10, concurrency: 2, interval_minutes: 240, expires_in_days: 7 },
    },
  })
  assert.equal(quoteResponse.statusCode, 200)
  assert.equal(quoteResponse.json().initial_status, 'quarantined')
  assert.equal(quoteResponse.json().target_base_url, 'https://api.example.com/v1')
  assert.equal(quoteResponse.json().provider.slug, 'example')
  assert.deepEqual(quoteResponse.json().groups[0].models, ['gpt-5.6-sol'])
  assert.deepEqual(quoteResponse.json().credential_treatment, {
    storage: 'aes-256-gcm-envelope', raw_value_in_business_record: false, deletion: 'on-revoke-or-expiry',
  })

  const secret = 'donated-secret-that-must-not-leak'
  const createHeaders = { 'idempotency-key': 'donation-test-idempotency-0001' }
  const createPayload = {
    quote_token: quoteResponse.json().quote_token,
    api_key: secret,
    group_id: 'default',
    consent: { disclosure_version: DONATION_DISCLOSURE_VERSION, accepted_at: new Date().toISOString() },
  }
  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/donations',
    headers: createHeaders,
    payload: createPayload,
  })
  assert.equal(createResponse.statusCode, 202)
  const created = createResponse.json()
  assert.equal(created.status, 'quarantined')
  assert.equal(JSON.stringify(created).includes(secret), false)
  const record = await services.contributionStore.getDonation(created.donation_id)
  assert.ok(record)
  assert.equal(JSON.stringify(record).includes(secret), false)
  assert.equal(await services.credentialVault.read(record.credentialHandle), secret)

  const replay = await app.inject({ method: 'POST', url: '/api/v1/donations', headers: createHeaders, payload: createPayload })
  assert.equal(replay.statusCode, 202)
  assert.equal(replay.json().donation_id, created.donation_id)
  assert.equal(replay.json().revocation_token, created.revocation_token)
  assert.equal(await services.credentialVault.read(record.credentialHandle), secret)

  const conflict = await app.inject({
    method: 'POST', url: '/api/v1/donations', headers: createHeaders,
    payload: { ...createPayload, api_key: 'different-secret' },
  })
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.json().code, 'idempotency_conflict')

  const hidden = await app.inject({ method: 'GET', url: created.status_url, headers: { authorization: 'Bearer invalid-invalid-invalid-invalid-invalid' } })
  assert.equal(hidden.statusCode, 404)

  const status = await app.inject({
    method: 'GET', url: created.status_url, headers: { authorization: `Bearer ${created.revocation_token}` },
  })
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().status, 'quarantined')

  const revoked = await app.inject({
    method: 'POST', url: `/api/v1/donations/${created.donation_id}/revoke`,
    headers: { authorization: `Bearer ${created.revocation_token}` },
  })
  assert.equal(revoked.statusCode, 200)
  assert.equal(revoked.json().status, 'revoked')
  await assert.rejects(() => services.credentialVault.read(record.credentialHandle))
})

test('registry proposals respect pinned Legacy prompts and remain GitOps-pending', async (context) => {
  const services = createMemoryServices(config)
  services.publicRepository = new MemoryPublicRepository([], 'release-test', [pinnedProbe])
  const app = await buildApp({ config, services, logger: false })
  context.after(() => app.close())

  const pinned = await app.inject({
    method: 'POST',
    url: '/api/v1/registry/proposals',
    payload: {
      probe_id: pinnedProbe.id,
      field: 'prompt_template',
      current_value: pinnedProbe.prompt_template,
      proposed_value: 'Use an easier prompt.',
      reason: 'This request intentionally attempts to rewrite a calibrated prompt.',
      evidence_urls: [],
    },
  })
  assert.equal(pinned.statusCode, 409)
  assert.equal(pinned.json().code, 'prompt_pinned')

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/registry/proposals',
    payload: {
      probe_id: pinnedProbe.id,
      field: 'label',
      current_value: 'Juice high',
      proposed_value: 'Juice high signature',
      reason: 'The expanded label distinguishes this probe from behavioral checks.',
      evidence_urls: ['https://github.com/example/model-observatory/issues/1'],
    },
  })
  assert.equal(created.statusCode, 202)
  assert.equal(created.json().status, 'gitops_pending')
  assert.match(created.json().content_sha256, /^[a-f0-9]{64}$/)
  assert.match(created.json().issue_url, /^https:\/\/github\.com\/example\/model-observatory\/issues\/new\?/)

  const fetched = await app.inject({ method: 'GET', url: `/api/v1/registry/proposals/${created.json().proposal_id}` })
  assert.equal(fetched.statusCode, 200)
  assert.equal(fetched.json().content_sha256, created.json().content_sha256)
})

test('retired provider domains cannot receive new donation quotes', async (context) => {
  const retiredRegistry = createProviderRegistry(parseProviderRegistry({
    schema_version: 2,
    pricing: { input_per_million_usd: 1.25, output_per_million_usd: 10 },
    providers: [{
      slug: 'retired-example', name: 'Retired Example', kind: 'relay',
      domains: [{ hostname: 'retired.example.com', role: 'primary', default_base_path: '/v1', status: 'retired' }],
      group_detection: { probe_model: '__group_probe__' },
      groups: [{ id: 'default', name: 'Default', aliases: [], multiplier: 1, models: ['gpt-5.6-sol'] }],
    }],
  }))
  const services = createMemoryServices(config, retiredRegistry)
  const app = await buildApp({ config, services, logger: false })
  context.after(() => app.close())

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/donations/quote',
    payload: { kind: 'api', base_url: 'https://retired.example.com/v1', constraints: { quota_usd: 10, concurrency: 1, interval_minutes: 240, expires_in_days: 7 } },
  })
  assert.equal(response.statusCode, 404)
  assert.equal(response.json().code, 'provider_not_registered')
})
