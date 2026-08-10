import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

test('health endpoint returns versioned metadata and security headers', async (context) => {
  const app = await buildApp({
    config: loadConfig({ APP_ENV: 'test', ENABLE_API_DOCS: 'false' }),
    logger: false,
  })
  context.after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/api/v1/health' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.ok(response.headers['x-request-id'])
  assert.deepEqual(response.json(), {
    status: 'ok',
    service: 'model-observatory-api',
    version: '0.1.0',
    generated_at: response.json().generated_at,
    data_version: 'observatory-data-v1',
    method_version: 'legacy-compatible-v1',
  })
})

test('unknown routes use the stable problem format', async (context) => {
  const app = await buildApp({
    config: loadConfig({ APP_ENV: 'test', ENABLE_API_DOCS: 'false' }),
    logger: false,
  })
  context.after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/missing' })
  assert.equal(response.statusCode, 404)
  assert.equal(response.headers['content-type'], 'application/problem+json; charset=utf-8')
  assert.equal(response.json().code, 'not_found')
})
