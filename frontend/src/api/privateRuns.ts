import { apiUrl } from '../config'
import type { PriceAssumption } from '../pricing'
import type { RunConfig } from '../probes'

export const PRIVATE_RUN_DISCLOSURE_VERSION = 'remote-normal-v1' as const

export type PrivateRunStatus =
  | 'queued' | 'provisioning' | 'running' | 'scoring' | 'completed'
  | 'failed' | 'cancelled' | 'timed_out' | 'incomplete' | 'deleted'

interface ApiErrorBody { detail?: string; code?: string }

export class PrivateRunApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PrivateRunApiError'
    this.status = status
    this.code = code
  }
}

async function json<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  let problem: ApiErrorBody = {}
  try { problem = await response.json() as ApiErrorBody } catch { /* Proxy failures can be non-JSON. */ }
  throw new PrivateRunApiError(response.status, problem.code ?? 'request_failed', problem.detail ?? `请求失败（${response.status}）`)
}

function apiConfig(config: RunConfig) {
  return {
    probes: config.probes.map((probe) => ({ probe_id: probe.probeId, requests: probe.requests })),
    formats: config.formats,
    contexts: config.contexts,
    workers: config.workers,
    retries: config.retries,
  }
}

export interface PrivateRunHandle {
  runId: string
  ownerToken: string
  status: PrivateRunStatus
  eventsUrl: string
  expiresAt: string
  apiOrigin: string
}

export interface PreparedPrivateRunSubmission {
  quoteToken: string
}

export interface PrivateRunReport {
  run_id: string
  status: PrivateRunStatus
  terminal: boolean
  scoring_release_id: string
  target: { origin: string; model: string }
  summary: Record<string, unknown>
  observations: Record<string, unknown>[]
  created_at: string
}

export interface PrivateRunEvent {
  id: string
  type: string
  payload: Record<string, unknown>
}

export async function createPrivateRun(input: {
  apiOrigin: string
  baseUrl: string
  model: string
  apiKey: string
  config: RunConfig
  maximumBudgetUsd: number
  price: PriceAssumption
  multiplier: number
  idempotencyKey: string
  prepared?: PreparedPrivateRunSubmission
  onPrepared?: (prepared: PreparedPrivateRunSubmission) => void
  signal?: AbortSignal
}): Promise<PrivateRunHandle> {
  let prepared = input.prepared
  if (!prepared) {
    const quote = await json<{ quote_token: string }>(await fetch(apiUrl('/api/v1/private-runs/quote', input.apiOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        base_url: input.baseUrl,
        model: input.model,
        config: apiConfig(input.config),
        maximum_budget_usd: input.maximumBudgetUsd,
        pricing: {
          input_per_million: input.price.inputPerMillion,
          output_per_million: input.price.outputPerMillion,
          multiplier: input.multiplier,
        },
      }),
      signal: input.signal,
    }))
    prepared = { quoteToken: quote.quote_token }
    input.onPrepared?.(prepared)
  }
  const created = await json<{
    run_id: string; owner_token: string; status: PrivateRunStatus; events_url: string; expires_at: string
  }>(await fetch(apiUrl('/api/v1/private-runs', input.apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify({
      quote_token: prepared.quoteToken,
      api_key: input.apiKey,
      consent: { disclosure_version: PRIVATE_RUN_DISCLOSURE_VERSION, accepted_at: new Date().toISOString() },
    }),
    signal: input.signal,
  }))
  return {
    runId: created.run_id,
    ownerToken: created.owner_token,
    status: created.status,
    eventsUrl: created.events_url,
    expiresAt: created.expires_at,
    apiOrigin: input.apiOrigin,
  }
}

function parseEvents(raw: string): PrivateRunEvent[] {
  return raw.split(/\r?\n\r?\n/).flatMap((block) => {
    let id = ''
    let type = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('id:')) id = line.slice(3).trim()
      else if (line.startsWith('event:')) type = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (!id || !data.length) return []
    try { return [{ id, type, payload: JSON.parse(data.join('\n')) as Record<string, unknown> }] }
    catch { return [] }
  })
}

export async function getPrivateRunReport(handle: PrivateRunHandle, signal?: AbortSignal): Promise<PrivateRunReport> {
  return json<PrivateRunReport>(await fetch(apiUrl(`/api/v1/private-runs/${handle.runId}/report`, handle.apiOrigin), {
    headers: { authorization: `Bearer ${handle.ownerToken}`, accept: 'application/json' },
    signal,
  }))
}

export async function waitForPrivateRun(
  handle: PrivateRunHandle,
  onEvent: (event: PrivateRunEvent) => void,
  signal?: AbortSignal,
): Promise<PrivateRunReport> {
  let cursor = '0'
  for (;;) {
    const response = await fetch(apiUrl(handle.eventsUrl, handle.apiOrigin), {
      headers: { authorization: `Bearer ${handle.ownerToken}`, 'last-event-id': cursor, accept: 'text/event-stream' },
      signal,
    })
    if (!response.ok) await json<never>(response)
    for (const event of parseEvents(await response.text())) {
      cursor = event.id
      onEvent(event)
    }
    try {
      return await getPrivateRunReport(handle, signal)
    } catch (error) {
      if (!(error instanceof PrivateRunApiError) || error.status !== 409) throw error
    }
  }
}

export async function cancelPrivateRun(handle: PrivateRunHandle): Promise<PrivateRunStatus> {
  const response = await json<{ status: PrivateRunStatus }>(await fetch(
    apiUrl(`/api/v1/private-runs/${handle.runId}/cancel`, handle.apiOrigin),
    { method: 'POST', headers: { authorization: `Bearer ${handle.ownerToken}` } },
  ))
  return response.status
}
