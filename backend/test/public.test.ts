import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApp } from '../src/app.js'
import type { PublicProvider, PublicRegistryItem } from '../src/contracts/public.js'
import { loadConfig } from '../src/config.js'
import { createMemoryServices } from '../src/services.js'
import { MemoryPublicRepository } from '../src/store/public-repository.js'

const provider: PublicProvider = {
  slug: 'example-relay',
  name: 'Example Relay',
  kind: 'relay',
  endpoint: 'https://api.example.test',
  domains: ['api.example.test'],
  lastCheckedAt: '2026-08-10T12:00:00.000Z',
  history: [82, 84, 86],
  groups: [
    {
      id: 'default',
      kind: 'none',
      label: 'Default',
      models: [
        {
          model: 'gpt-5.6-sol',
          bySource: { vendor: 98, donated: 84, community: 88 },
          samples: { vendor: 3, donated: 12, community: 20 },
          availabilityBySource: { vendor: 100, donated: 96, community: 98 },
          attemptedSamples: { vendor: 3, donated: 768, community: 1280 },
          inconclusiveSamples: { vendor: 0, donated: 1, community: 2 },
          attribution: { verified: 10, donor_declared: 3 },
        },
      ],
    },
  ],
  anomalies: [],
}

const registryItem: PublicRegistryItem = {
  id: 'instruction-refusal',
  category: 'behavior',
  prompt_template: 'Return only the requested marker.',
  prompt_sha256: '7e5ec06c13a423e7ea51dbfb1eb07994d9ac05d9a7810b70f055b0037d5259e0',
  scoring_kind: 'exact',
  prompt_rewrite_allowed: false,
  status: 'stable',
  metadata: { source: 'legacy/runtime_catalog.json' },
}

test('dashboard exposes three evidence layers with the public headline policy', async (context) => {
  const config = loadConfig({ APP_ENV: 'test', ENABLE_API_DOCS: 'false' })
  const services = createMemoryServices(config)
  services.publicRepository = new MemoryPublicRepository([provider], 'release-test', [registryItem])
  const app = await buildApp({ config, services, logger: false })
  context.after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/api/v1/dashboard' })
  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers['cache-control']), /^public, max-age=60/)
  assert.ok(response.headers.etag)
  assert.deepEqual(response.json().source_policy, {
    headline_sources: ['donated', 'community'],
    excluded_sources: ['vendor'],
  })
  assert.deepEqual(response.json().providers[0].groups[0].models[0].bySource, {
    vendor: 98,
    donated: 84,
    community: 88,
  })
})

test('provider and registry reads preserve not-found and release boundaries', async (context) => {
  const config = loadConfig({ APP_ENV: 'test', ENABLE_API_DOCS: 'false' })
  const services = createMemoryServices(config)
  services.publicRepository = new MemoryPublicRepository([provider], 'release-test', [registryItem])
  const app = await buildApp({ config, services, logger: false })
  context.after(() => app.close())

  const known = await app.inject({ method: 'GET', url: '/api/v1/providers/example-relay' })
  assert.equal(known.statusCode, 200)
  assert.equal(known.json().provider.slug, 'example-relay')

  const missing = await app.inject({ method: 'GET', url: '/api/v1/providers/missing' })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().code, 'provider_not_found')

  const registry = await app.inject({ method: 'GET', url: '/api/v1/registry?status=stable' })
  assert.equal(registry.statusCode, 200)
  assert.equal(registry.json().release_id, 'release-test')
  assert.deepEqual(registry.json().items, [registryItem])
})
