import { apiUrl } from '../config'

const API_PREFIX = '/api/v1'
export const DONATION_DISCLOSURE_VERSION = 'donation-api-v1' as const

interface ApiErrorBody { detail?: string; code?: string; request_id?: string }

export class ContributionApiError extends Error {
  readonly code: string | null
  readonly requestId: string | null

  constructor(message: string, code: string | null, requestId: string | null) {
    super(message)
    this.name = 'ContributionApiError'
    this.code = code
    this.requestId = requestId
  }
}

async function json<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  let problem: ApiErrorBody = {}
  try { problem = await response.json() as ApiErrorBody } catch { /* Non-JSON proxy failures use the fallback below. */ }
  throw new ContributionApiError(problem.detail ?? `请求失败（${response.status}）`, problem.code ?? null, problem.request_id ?? null)
}

export interface DonationGroupQuote {
  id: string
  name: string
  multiplier: number
  models: string[]
  requests_per_model: number
  estimated_cost_usd: number
  maximum_cost_usd: number
}

export interface DonationQuote {
  quote_token: string
  target_base_url: string
  provider: { slug: string; name: string; kind: 'relay' | 'official' | 'official_proxy' }
  groups: DonationGroupQuote[]
  expires_at: string
}

export async function quoteApiDonation(input: {
  baseUrl: string; quotaUsd: number; concurrency: number; intervalMinutes: number; signal?: AbortSignal
}): Promise<DonationQuote> {
  return json<DonationQuote>(await fetch(apiUrl(`${API_PREFIX}/donations/quote`), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'api', base_url: input.baseUrl,
      constraints: { quota_usd: input.quotaUsd, concurrency: input.concurrency, interval_minutes: input.intervalMinutes, expires_in_days: 30 },
    }),
    signal: input.signal,
  }))
}

export interface DonationReceipt {
  donation_id: string
  status: 'quarantined' | 'active' | 'revoked' | 'expired' | 'rejected'
  credential_fingerprint_tail: string
  revocation_token: string
  revocation_token_tail: string
  status_url: string
  expires_at: string
}

export interface PreparedDonationSubmission {
  quoteToken: string
}

export interface DonationStatus {
  donation_id: string
  status: DonationReceipt['status']
  provider: { slug: string; name: string }
  group: { id: string; name: string; multiplier: number; models: string[] }
  detected_group_id: string | null
  group_attribution: 'pending' | 'verified' | 'donor_declared'
  phase: string
  progress_current: number
  progress_total: number
  current_model: string | null
  next_run_at: string | null
  last_checked_at: string | null
  quota: { limit_usd: number; spent_usd: number; reserved_usd: number; remaining_usd: number }
  errors: Array<{ stage: string; code: string; message: string; model: string | null; http_status: number | null; retryable: boolean; at: string }>
  expires_at: string
  revoked_at: string | null
}

export async function fetchDonationStatus(statusUrl: string, revocationToken: string, signal?: AbortSignal): Promise<DonationStatus> {
  return json<DonationStatus>(await fetch(apiUrl(statusUrl), {
    headers: { accept: 'application/json', authorization: `Bearer ${revocationToken}` }, signal,
  }))
}

export async function submitApiDonation(input: {
  baseUrl: string
  apiKey: string
  quotaUsd: number
  intervalMinutes: number
  concurrency: number
  groupId: string
  idempotencyKey: string
  prepared?: PreparedDonationSubmission
  onPrepared?: (prepared: PreparedDonationSubmission) => void
  signal?: AbortSignal
}): Promise<DonationReceipt> {
  let prepared = input.prepared
  if (!prepared) {
    const quote = await quoteApiDonation({ baseUrl: input.baseUrl, quotaUsd: input.quotaUsd, concurrency: input.concurrency, intervalMinutes: input.intervalMinutes, signal: input.signal })
    prepared = { quoteToken: quote.quote_token }
    input.onPrepared?.(prepared)
  }
  return json<DonationReceipt>(await fetch(apiUrl(`${API_PREFIX}/donations`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify({
      quote_token: prepared.quoteToken,
      api_key: input.apiKey,
      group_id: input.groupId,
      consent: { disclosure_version: DONATION_DISCLOSURE_VERSION, accepted_at: new Date().toISOString() },
    }),
    signal: input.signal,
  }))
}

export interface RegistryProposalReceipt {
  proposal_id: string
  status: 'gitops_pending'
  content_sha256: string
  issue_url: string
  created_at: string
}

export async function createRegistryProposal(input: {
  probeId: string
  field: 'label' | 'scoring_note' | 'prompt_template' | 'expected_answer'
  currentValue: string
  proposedValue: string
  reason: string
}): Promise<RegistryProposalReceipt> {
  return json<RegistryProposalReceipt>(await fetch(apiUrl(`${API_PREFIX}/registry/proposals`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      probe_id: input.probeId,
      field: input.field,
      current_value: input.currentValue,
      proposed_value: input.proposedValue,
      reason: input.reason,
      evidence_urls: [],
    }),
  }))
}
