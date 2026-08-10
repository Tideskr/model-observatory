import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createMemoryServices } from '../src/services.js'

const config = loadConfig({
  APP_ENV: 'test',
  ENABLE_API_DOCS: 'false',
  TOKEN_PEPPER: 'token-pepper-for-private-run-tests-123456',
  QUOTE_SIGNING_SECRET: 'quote-secret-for-private-run-tests-12345',
  CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
})

const lowConfig = {
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
  retries: 2,
}

async function quote(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/private-runs/quote',
    payload: { base_url: 'https://api.example.com/v1/', model: 'gpt-5.6-sol', config: lowConfig, maximum_budget_usd: 1 },
  })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

test('quote is server-authoritative and rejects remote Native format', async (context) => {
  const app = await buildApp({ config, logger: false })
  context.after(() => app.close())
  const body = await quote(app)
  assert.equal(body.estimate.requests, 14)
  assert.equal(body.target_base_url, 'https://api.example.com/v1')
  assert.equal(body.disclosure_version, 'remote-normal-v1')

  const rejected = await app.inject({
    method: 'POST',
    url: '/api/v1/private-runs/quote',
    payload: { base_url: 'https://api.example.com/v1', model: 'gpt-5.6-sol', config: { ...lowConfig, formats: ['native_codex'] }, maximum_budget_usd: 1 },
  })
  assert.equal(rejected.statusCode, 400)
})

test('quote rejects private, local, and nonstandard-port targets', async (context) => {
  const app = await buildApp({ config, logger: false })
  context.after(() => app.close())
  for (const baseUrl of ['https://127.0.0.1/v1', 'https://localhost/v1', 'https://api.example.com:8443/v1']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/private-runs/quote',
      payload: { base_url: baseUrl, model: 'gpt-5.6-sol', config: lowConfig, maximum_budget_usd: 1 },
    })
    assert.equal(response.statusCode, 400, baseUrl)
  }
})

test('private run lifecycle is capability-protected and idempotent', async (context) => {
  const services = createMemoryServices(config)
  const app = await buildApp({ config, services, logger: false })
  context.after(() => app.close())
  const quoted = await quote(app)
  const payload = {
    quote_token: quoted.quote_token,
    api_key: 'temporary-test-key-never-returned',
    consent: { disclosure_version: 'remote-normal-v1', accepted_at: new Date().toISOString() },
  }
  const headers = { 'idempotency-key': 'private-run-test-key-0001' }
  const created = await app.inject({ method: 'POST', url: '/api/v1/private-runs', headers, payload })
  assert.equal(created.statusCode, 202, created.body)
  assert.equal(created.body.includes('temporary-test-key-never-returned'), false)
  const run = created.json()
  const stored = await services.runStore.get(run.run_id)
  assert.ok(stored)

  const replay = await app.inject({ method: 'POST', url: '/api/v1/private-runs', headers, payload })
  assert.equal(replay.statusCode, 202)
  assert.equal(replay.json().run_id, run.run_id)
  assert.equal(replay.json().owner_token, run.owner_token)

  const unauthorized = await app.inject({ method: 'GET', url: `/api/v1/private-runs/${run.run_id}/report`, headers: { authorization: 'Bearer wrong-token-that-is-long-enough-123456' } })
  assert.equal(unauthorized.statusCode, 404)

  const authorization = { authorization: `Bearer ${run.owner_token}` }
  const cancelled = await app.inject({ method: 'POST', url: `/api/v1/private-runs/${run.run_id}/cancel`, headers: authorization })
  assert.equal(cancelled.statusCode, 200)
  assert.equal(cancelled.json().status, 'cancelled')

  const events = await app.inject({ method: 'GET', url: `/api/v1/private-runs/${run.run_id}/events`, headers: authorization })
  assert.equal(events.statusCode, 200)
  assert.match(events.body, /event: status/)
  assert.match(events.body, /event: cancelled/)

  const report = await app.inject({ method: 'GET', url: `/api/v1/private-runs/${run.run_id}/report`, headers: authorization })
  assert.equal(report.statusCode, 200)
  assert.equal(report.json().terminal, true)
  assert.equal(report.json().status, 'cancelled')

  const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/private-runs/${run.run_id}`, headers: authorization })
  assert.equal(deleted.statusCode, 204)
  const missing = await app.inject({ method: 'GET', url: `/api/v1/private-runs/${run.run_id}/report`, headers: authorization })
  assert.equal(missing.statusCode, 404)
  assert.equal(await services.runStore.get(run.run_id), null)
  assert.equal(await services.runStore.getReport(run.run_id), null)
  await assert.rejects(() => services.credentialVault.read(stored.credentialHandle))
})
