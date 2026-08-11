import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { AdminService } from '../src/admin/service.js'
import { GitHubAdminClient, GitHubApiError } from '../src/admin/github.js'
import { buildApp } from '../src/app.js'
import { loadConfig, type GitHubAdminConfig } from '../src/config.js'
import type { DatabasePool } from '../src/db/connection.js'
import { createProviderRegistry, parseProviderRegistry } from '../src/registry/catalog.js'
import { ReloadableProviderRegistry } from '../src/registry/runtime.js'
import { createMemoryServices } from '../src/services.js'
import { syncProviderRegistry } from '../src/registry/sync.js'

const document = parseProviderRegistry({
  schema_version: 2,
  pricing: { input_per_million_usd: 1.25, output_per_million_usd: 10 },
  providers: [{
    slug: 'example', name: 'Example', kind: 'relay',
    domains: [{ hostname: 'api.example.com', role: 'primary', default_base_path: '/v1', status: 'active' }],
    group_detection: { probe_model: '__probe__' },
    groups: [{ id: 'default', name: 'Default', aliases: [], multiplier: 1, models: ['gpt-5.6-sol'] }],
  }],
})

function adminConfig(): GitHubAdminConfig {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    appId: '123', clientId: 'client', clientSecret: 'secret', installationId: 456,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    allowedUserIds: new Set([42]), sessionSecret: 's'.repeat(32), owner: 'Tideskr', repository: 'model-observatory',
    branch: 'main', registryPath: 'registry/providers.json', callbackUrl: 'https://check.skr.moe/api/v1/admin/auth/github/callback',
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('GitHub registry client scopes its installation token and uses the current blob SHA', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const replies = [
    response({ token: 'installation-token', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }, 201),
    response({ sha: 'blob-before', encoding: 'base64', content: Buffer.from(JSON.stringify(document)).toString('base64') }),
    response({ commit: { sha: 'commit-after' }, content: { sha: 'blob-after' } }),
  ]
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return replies.shift()!
  }) as typeof fetch
  const client = new GitHubAdminClient(adminConfig(), request)
  const file = await client.getRegistryFile()
  assert.equal(file.blobSha, 'blob-before')
  assert.equal(file.document.providers[0]?.slug, 'example')
  const committed = await client.updateRegistryFile(document, file.blobSha, 'cae')
  assert.deepEqual(committed, { commitSha: 'commit-after', contentSha: 'blob-after' })
  const installationBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
  assert.deepEqual(installationBody['repositories'], ['model-observatory'])
  assert.deepEqual(installationBody['permissions'], { contents: 'write' })
  const updateBody = JSON.parse(String(calls[2]?.init?.body)) as Record<string, unknown>
  assert.equal(updateBody['sha'], 'blob-before')
  assert.equal(updateBody['branch'], 'main')
  assert.match(String(updateBody['message']), /@cae/)
})

test('GitHub registry client preserves update conflicts', async () => {
  const replies = [
    response({ token: 'installation-token', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }, 201),
    response({ message: 'conflict' }, 409),
  ]
  const client = new GitHubAdminClient(adminConfig(), (async () => replies.shift()!) as typeof fetch)
  await assert.rejects(() => client.updateRegistryFile(document, 'stale-blob', 'cae'), (error: unknown) => {
    return error instanceof GitHubApiError && error.status === 409
  })
})

test('OAuth state and PKCE payload reject tampering', () => {
  const registry = new ReloadableProviderRegistry(createProviderRegistry(document))
  const service = new AdminService(adminConfig(), {} as DatabasePool, registry)
  const flow = service.beginOAuth()
  assert.equal(service.consumeOAuth(flow.cookie, flow.state).verifier, flow.verifier)
  assert.throws(() => service.consumeOAuth(`${flow.cookie}x`, flow.state), /authorization state is invalid/)
  assert.throws(() => service.consumeOAuth(flow.cookie, `${flow.state}x`), /authorization state is invalid/)
})

test('unpublished draft deletion is atomic and audited', async () => {
  const statements: Array<{ sql: string; values: unknown[] | undefined }> = []
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values })
      if (sql.includes('DELETE FROM provider_registry_drafts')) {
        return { rows: [{ revision: 3, base_content_sha256: 'a'.repeat(64) }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  const pool = { connect: async () => client } as unknown as DatabasePool
  const service = new AdminService(adminConfig(), pool, new ReloadableProviderRegistry(createProviderRegistry(document)))
  const draftId = '11111111-1111-4111-8111-111111111111'
  await service.deleteDraft(draftId, { id: 42, login: 'cae', avatarUrl: '' })

  const deletion = statements.find((item) => item.sql.includes('DELETE FROM provider_registry_drafts'))
  assert.match(deletion?.sql ?? '', /status='draft'/)
  assert.deepEqual(deletion?.values, [draftId])
  const audit = statements.find((item) => item.sql.includes('INSERT INTO audit_events'))
  assert.deepEqual(audit?.values?.slice(0, 4), ['provider_registry.draft.deleted', 'provider_registry_draft', draftId, 'github_admin'])
  assert.equal(statements[0]?.sql, 'BEGIN')
  assert.equal(statements.at(-1)?.sql, 'COMMIT')
})

test('reloadable registry swaps complete immutable snapshots', () => {
  const first = createProviderRegistry(document)
  const runtime = new ReloadableProviderRegistry(first)
  const changed = createProviderRegistry(parseProviderRegistry({ ...document, pricing: { ...document.pricing, input_per_million_usd: 2 } }))
  const captured = runtime.snapshot()
  assert.equal(runtime.replace(changed), true)
  assert.equal(runtime.document.pricing.input_per_million_usd, 2)
  assert.equal(captured.document.pricing.input_per_million_usd, 1.25)
  assert.equal(runtime.replace(changed), false)
})

test('admin routes remain isolated when GitHub administration is not configured', async (context) => {
  const app = await buildApp({ config: loadConfig({ APP_ENV: 'test', ENABLE_API_DOCS: 'false' }), logger: false })
  context.after(() => app.close())
  const session = await app.inject({ method: 'GET', url: '/api/v1/admin/session' })
  assert.equal(session.statusCode, 200)
  assert.equal(session.headers['cache-control'], 'no-store')
  assert.deepEqual(session.json(), { enabled: false, authenticated: false, user: null, csrf_token: null })
  const registry = await app.inject({ method: 'GET', url: '/api/v1/admin/registry' })
  assert.equal(registry.statusCode, 404)
  assert.equal(registry.json().code, 'admin_unavailable')
})

test('admin mutations require both the trusted origin and CSRF token', async (context) => {
  const config = loadConfig({ APP_ENV: 'test', ENABLE_API_DOCS: 'false', PUBLIC_ORIGIN: 'https://check.example' })
  const services = createMemoryServices(config, createProviderRegistry(document))
  const identity = { id: 42, login: 'cae', avatarUrl: '' }
  let deletedDraftId: string | null = null
  services.adminService = {
    session: async (token?: string) => token === 'session-token' ? { identity, csrfToken: 'csrf-token' } : null,
    verifyCsrf: (_token: string, value?: string) => value === 'csrf-token',
    currentRegistry: async () => ({ document, contentSha256: 'a'.repeat(64), gitBlobSha: 'blob', gitContentSha256: 'a'.repeat(64), synchronized: true }),
    deleteDraft: async (id: string) => { deletedDraftId = id },
  } as unknown as AdminService
  const app = await buildApp({ config, services, logger: false })
  context.after(() => app.close())
  const headers = { cookie: 'mo_admin=session-token', 'content-type': 'application/json' }
  const missingOrigin = await app.inject({ method: 'POST', url: '/api/v1/admin/registry/drafts', headers, payload: {} })
  assert.equal(missingOrigin.statusCode, 403)
  assert.equal(missingOrigin.json().code, 'admin_origin_invalid')
  const missingCsrf = await app.inject({ method: 'POST', url: '/api/v1/admin/registry/drafts', headers: { ...headers, origin: 'https://check.example' }, payload: {} })
  assert.equal(missingCsrf.statusCode, 403)
  assert.equal(missingCsrf.json().code, 'admin_csrf_invalid')
  const draftId = '11111111-1111-4111-8111-111111111111'
  const deleted = await app.inject({
    method: 'DELETE', url: `/api/v1/admin/registry/drafts/${draftId}`,
    headers: { cookie: 'mo_admin=session-token', origin: 'https://check.example', 'x-csrf-token': 'csrf-token' },
  })
  assert.equal(deleted.statusCode, 204, deleted.body)
  assert.equal(deletedDraftId, draftId)
})

test('registry synchronization persists the full document and emits a commit-scoped notification', async () => {
  const statements: Array<{ sql: string; values: unknown[] | undefined }> = []
  const client = {
    query: async (sql: string, values?: unknown[]) => { statements.push({ sql, values }); return { rows: [], rowCount: 0 } },
    release() {},
  }
  const pool = { connect: async () => client } as unknown as DatabasePool
  const registry = createProviderRegistry(document)
  await syncProviderRegistry(pool, registry, { gitCommitSha: 'commit-sha', activatedBy: 'github:42' })
  const versionUpsert = statements.find((item) => item.sql.includes('provider_registry_versions'))
  const stateUpsert = statements.find((item) => item.sql.includes('provider_registry_state'))
  assert.match(versionUpsert?.sql ?? '', /activated_by=CASE/)
  assert.match(stateUpsert?.sql ?? '', /activated_by=CASE/)
  const draftActivation = statements.find((item) => item.sql.includes("status='committed_pending_activation'"))
  assert.deepEqual(draftActivation?.values, ['commit-sha'])
  const notification = statements.find((item) => item.sql.includes("pg_notify('provider_registry_updated'"))
  assert.deepEqual(notification?.values, [registry.contentSha256])
  assert.equal(statements.at(-1)?.sql, 'COMMIT')
})

test('admin migration and deployment script preserve atomic hot-publish boundaries', async () => {
  const migration = await readFile(resolve(process.cwd(), 'migrations', '010_provider_registry_admin.sql'), 'utf8')
  assert.match(migration, /CREATE TABLE provider_registry_state/)
  assert.match(migration, /document jsonb NOT NULL/)
  assert.match(migration, /CREATE TABLE admin_sessions/)
  assert.match(migration, /CREATE TABLE provider_registry_drafts/)
  const deploy = await readFile(resolve(process.cwd(), '..', 'deploy', 'server-deploy.sh'), 'utf8')
  assert.match(deploy, /registry_only=1/)
  assert.match(deploy, /--no-deps/)
  assert.match(deploy, /wait_for_registry/)
  assert.match(deploy, /registry_sync "\$previous_commit"/)
})

test('partial GitHub admin configuration fails closed', () => {
  assert.throws(() => loadConfig({ APP_ENV: 'test', GITHUB_ADMIN_APP_ID: '123' }), /configuration is incomplete/)
})
