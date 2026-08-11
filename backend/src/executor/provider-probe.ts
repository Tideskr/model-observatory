import https from 'node:https'
import { createPinnedLookup } from './normal-transport.js'
import { resolvePublicTarget } from './ssrf.js'
import type { RegistryProvider } from '../registry/catalog.js'

const MAX_BYTES = 256 * 1024
const TIMEOUT_MS = 20_000

export interface ProviderProbeError {
  stage: 'identity_probe'
  code: string
  message: string
  model: null
  http_status: number | null
  retryable: boolean
  at: string
}

export interface ProviderProbeResult {
  detectedGroupId: string | null
  attribution: 'verified' | 'donor_declared'
  catalogModels: string[]
  errors: ProviderProbeError[]
}

interface RawResponse { status: number; body: string; requestId: string | null }

function redact(value: string): string {
  return Array.from(value, (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('')
    .replace(/\b(sk|sess|key)-[A-Za-z0-9_-]{12,}\b/gi, '$1-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 800)
}

function request(baseUrl: string, apiKey: string, method: 'GET' | 'POST', suffix: string, body?: string): Promise<RawResponse> {
  return (async () => {
    const base = new URL(baseUrl)
    const pinned = await resolvePublicTarget(base.hostname)
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}${suffix}`)
    return new Promise<RawResponse>((resolve, reject) => {
      const req = https.request({
        protocol: 'https:', hostname: base.hostname, port: 443, path: `${url.pathname}${url.search}`, method,
        headers: {
          authorization: `Bearer ${apiKey}`, accept: 'application/json',
          ...(body == null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          'user-agent': 'model-observatory-worker/0.1',
        },
        lookup: createPinnedLookup(pinned), servername: base.hostname, agent: false, rejectUnauthorized: true,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }, (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_BYTES) req.destroy(new Error('probe_response_too_large'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          requestId: typeof response.headers['x-request-id'] === 'string' ? response.headers['x-request-id'].slice(0, 128) : null,
        }))
      })
      req.on('error', reject)
      req.end(body)
    })
  })()
}

function message(body: string): string {
  try {
    const value = JSON.parse(body) as Record<string, unknown>
    const problem = value['error'] && typeof value['error'] === 'object' ? value['error'] as Record<string, unknown> : value
    if (typeof problem['message'] === 'string') return redact(problem['message'])
    if (typeof problem['detail'] === 'string') return redact(problem['detail'])
  } catch { /* The status and a generic message are still useful. */ }
  return redact(body) || 'Upstream returned an empty response.'
}

function modelIds(body: string): string[] {
  try {
    const value = JSON.parse(body) as Record<string, unknown>
    if (!Array.isArray(value['data'])) return []
    return value['data'].flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>)['id'] === 'string'
      ? [(item as Record<string, string>)['id']!]
      : [])
  } catch { return [] }
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-Hans').replace(/\s+/g, '')
}

function matchingGroups(provider: RegistryProvider, errorText: string): RegistryProvider['groups'] {
  const haystack = normalized(errorText)
  return provider.groups.filter((group) => [group.name, ...group.aliases].some((label) => haystack.includes(normalized(label))))
}

export async function probeProviderIdentity(input: {
  baseUrl: string; apiKey: string; provider: RegistryProvider; selectedGroupId: string
}): Promise<ProviderProbeResult> {
  const errors: ProviderProbeError[] = []
  let catalog: RawResponse
  try { catalog = await request(input.baseUrl, input.apiKey, 'GET', '/models') } catch (error) {
    errors.push({ stage: 'identity_probe', code: 'provider_probe_connection_failed', message: redact(error instanceof Error ? error.message : 'Connection failed.'), model: null, http_status: null, retryable: true, at: new Date().toISOString() })
    return { detectedGroupId: null, attribution: 'donor_declared', catalogModels: [], errors }
  }
  if (catalog.status === 401 || catalog.status === 403) {
    errors.push({ stage: 'identity_probe', code: 'credential_rejected', message: message(catalog.body), model: null, http_status: catalog.status, retryable: false, at: new Date().toISOString() })
    return { detectedGroupId: null, attribution: 'donor_declared', catalogModels: [], errors }
  }
  if (catalog.status < 200 || catalog.status >= 300) {
    errors.push({ stage: 'identity_probe', code: 'model_catalog_failed', message: message(catalog.body), model: null, http_status: catalog.status, retryable: catalog.status === 429 || catalog.status >= 500, at: new Date().toISOString() })
  }
  const catalogModels = modelIds(catalog.body)
  const probeBody = JSON.stringify({ model: input.provider.group_detection.probe_model, input: 'ping', stream: false, max_output_tokens: 1 })
  let errorText = ''
  try {
    const probe = await request(input.baseUrl, input.apiKey, 'POST', '/responses', probeBody)
    errorText = message(probe.body)
    if (probe.status >= 500 || probe.status === 429) errors.push({ stage: 'identity_probe', code: 'group_probe_failed', message: errorText, model: null, http_status: probe.status, retryable: true, at: new Date().toISOString() })
  } catch (error) {
    errors.push({ stage: 'identity_probe', code: 'group_probe_connection_failed', message: redact(error instanceof Error ? error.message : 'Connection failed.'), model: null, http_status: null, retryable: true, at: new Date().toISOString() })
  }
  if (input.provider.groups.length > 1 && matchingGroups(input.provider, errorText).length !== 1) {
    const chatBody = JSON.stringify({ model: input.provider.group_detection.probe_model, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 })
    try {
      const chatProbe = await request(input.baseUrl, input.apiKey, 'POST', '/chat/completions', chatBody)
      errorText += ` ${message(chatProbe.body)}`
    } catch { /* The primary Responses probe remains authoritative for transport health. */ }
  }
  const matches = matchingGroups(input.provider, errorText)
  const detectedGroupId = matches.length === 1 ? matches[0]!.id : input.provider.groups.length === 1 ? input.provider.groups[0]!.id : null
  return { detectedGroupId, attribution: detectedGroupId ? 'verified' : 'donor_declared', catalogModels, errors }
}
