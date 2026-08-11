import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { MAX_OUTPUT_TOKENS } from '../domain/run-limits.js'
import { AppError } from '../errors.js'
import { resolvePublicTarget, type PinnedAddress } from './ssrf.js'

const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000

export interface TransportRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: { role: 'developer' | 'user'; content: string }[]
  effort: string
  cacheKey: string
  signal?: AbortSignal
}

export interface TransportResult {
  answer: string
  elapsedMs: number
  statusCode: number
  eventCount: number
}

export class TransportError extends Error {
  constructor(
    public readonly category: string,
    public readonly retryable: boolean,
    public readonly statusCode: number | null = null,
    detail?: string,
  ) {
    super(detail ?? transportErrorMessage(category, statusCode))
    this.name = 'TransportError'
  }
}

export function createPinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }])
      return
    }
    callback(null, pinned.address, pinned.family)
  }
}

function transportErrorMessage(category: string, statusCode: number | null): string {
  const labels: Record<string, string> = {
    invalid_response_stream: 'The upstream returned a malformed SSE stream.',
    stream_without_terminal_response: 'The upstream stream ended without a terminal response event.',
    upstream_response_failed: 'The upstream Responses request reported a failed terminal state.',
    upstream_response_incomplete: 'The upstream Responses request reported an incomplete terminal state.',
    response_too_large: 'The upstream response exceeded the 1 MiB safety limit.',
    upstream_http_error: 'The upstream returned a non-success HTTP status.',
    invalid_upstream_response: 'The upstream response was neither valid Responses JSON nor valid SSE.',
    connection_or_tls_error: 'The worker could not connect to the target or establish trusted TLS.',
  }
  const suffix = statusCode == null ? '' : ` HTTP status: ${statusCode}.`
  return `${labels[category] ?? category}${suffix}`
}

function connectionProblem(error: unknown): string {
  const code = error != null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code.slice(0, 64)
    : ''
  const base = transportErrorMessage('connection_or_tls_error', null)
  return code ? `${base} Network error code: ${code}.` : base
}

function upstreamProblem(raw: string, statusCode: number): string | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const error = value['error'] != null && typeof value['error'] === 'object' ? value['error'] as Record<string, unknown> : value
    const code = typeof error['code'] === 'string' ? error['code'].slice(0, 128) : ''
    const message = typeof error['message'] === 'string'
      ? Array.from(error['message'].slice(0, 500), (character) => character.charCodeAt(0) < 32 ? ' ' : character).join('')
      : ''
    if (code || message) return `Upstream HTTP ${statusCode}${code ? ` (${code})` : ''}: ${message || 'request rejected'}`
  } catch { /* Non-JSON error bodies are intentionally not reflected. */ }
  return undefined
}

function outputText(response: Record<string, unknown>): string {
  if (typeof response['output_text'] === 'string') return response['output_text'].trim()
  const chunks: string[] = []
  if (Array.isArray(response['output'])) {
    for (const item of response['output']) {
      if (item == null || typeof item !== 'object' || (item as Record<string, unknown>)['type'] !== 'message') continue
      const content = (item as Record<string, unknown>)['content']
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (part != null && typeof part === 'object' && typeof (part as Record<string, unknown>)['text'] === 'string') {
          chunks.push((part as Record<string, string>)['text']!)
        }
      }
    }
  }
  return chunks.join('').trim()
}

export function parseSseResponse(raw: string): { response: Record<string, unknown>; eventCount: number } {
  let terminal: Record<string, unknown> | null = null
  let terminalType = ''
  let streamed = ''
  let eventCount = 0
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      throw new TransportError('invalid_response_stream', true)
    }
    eventCount += 1
    if (event['type'] === 'response.output_text.delta' && typeof event['delta'] === 'string') streamed += event['delta']
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(String(event['type']))) {
      const response = event['response']
      if (response != null && typeof response === 'object') {
        terminal = response as Record<string, unknown>
        terminalType = String(event['type'])
      }
    }
  }
  if (!terminal) throw new TransportError('stream_without_terminal_response', true)
  if (terminalType === 'response.failed') throw new TransportError('upstream_response_failed', true)
  if (terminalType === 'response.incomplete') throw new TransportError('upstream_response_incomplete', true)
  if (!outputText(terminal) && streamed) terminal = { ...terminal, output_text: streamed.trim() }
  return { response: terminal, eventCount }
}

export async function sendNormalRequest(input: TransportRequest): Promise<TransportResult> {
  const base = new URL(input.baseUrl)
  if (base.protocol !== 'https:') throw new AppError(400, 'invalid_target', 'Remote execution requires HTTPS.')
  if (base.port && base.port !== '443') throw new AppError(400, 'target_port_blocked', 'Remote execution only permits HTTPS port 443.')
  const pinned = await resolvePublicTarget(base.hostname)
  const url = new URL(`${input.baseUrl.replace(/\/+$/, '')}/responses`)
  const payload = JSON.stringify({
    model: input.model,
    input: input.messages,
    reasoning: { effort: input.effort },
    include: ['reasoning.encrypted_content'],
    store: false,
    stream: true,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    prompt_cache_key: input.cacheKey,
  })
  const started = Date.now()

  return new Promise<TransportResult>((resolve, reject) => {
    const lookup = createPinnedLookup(pinned)
    const request = https.request(
      {
        protocol: 'https:',
        hostname: base.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream, application/json',
          'content-length': Buffer.byteLength(payload),
          'user-agent': 'model-observatory-worker/0.1',
        },
        servername: base.hostname,
        lookup,
        agent: false,
        rejectUnauthorized: true,
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      (response) => {
        const statusCode = response.statusCode ?? 0
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new TransportError('response_too_large', false, statusCode))
            return
          }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          if (statusCode < 200 || statusCode >= 300) {
            reject(new TransportError(
              'upstream_http_error',
              [408, 429, 500, 502, 503, 504].includes(statusCode),
              statusCode,
              upstreamProblem(Buffer.concat(chunks).toString('utf8'), statusCode),
            ))
            return
          }
          const raw = Buffer.concat(chunks).toString('utf8')
          try {
            const contentType = String(response.headers['content-type'] ?? '')
            if (contentType.includes('text/event-stream') || raw.trimStart().startsWith('data:')) {
              const parsed = parseSseResponse(raw)
              resolve({ answer: outputText(parsed.response), elapsedMs: Date.now() - started, statusCode, eventCount: parsed.eventCount })
            } else {
              const parsed = JSON.parse(raw) as Record<string, unknown>
              if (parsed['status'] === 'failed') throw new TransportError('upstream_response_failed', true, statusCode)
              if (parsed['status'] === 'incomplete') throw new TransportError('upstream_response_incomplete', true, statusCode)
              resolve({ answer: outputText(parsed), elapsedMs: Date.now() - started, statusCode, eventCount: 0 })
            }
          } catch (error) {
            reject(error instanceof TransportError ? error : new TransportError('invalid_upstream_response', true, statusCode))
          }
        })
      },
    )
    request.on('error', (error) => {
      reject(error instanceof TransportError ? error : new TransportError('connection_or_tls_error', true, null, connectionProblem(error)))
    })
    request.end(payload)
  })
}
