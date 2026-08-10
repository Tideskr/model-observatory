const API_PREFIX = '/api/v1'
export const DONATION_DISCLOSURE_VERSION = 'donation-api-v1' as const

interface ApiErrorBody { detail?: string; code?: string }

async function json<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  let problem: ApiErrorBody = {}
  try { problem = await response.json() as ApiErrorBody } catch { /* Non-JSON proxy failures use the fallback below. */ }
  throw new Error(problem.detail ?? `请求失败（${response.status}）`)
}

export interface DonationReceipt {
  donation_id: string
  status: 'quarantined'
  credential_fingerprint_tail: string
  revocation_token: string
  revocation_token_tail: string
  status_url: string
  expires_at: string
}

export async function submitApiDonation(input: {
  baseUrl: string
  apiKey: string
  quotaUsd: number
  intervalMinutes: number
  signal?: AbortSignal
}): Promise<DonationReceipt> {
  const quote = await json<{ quote_token: string }>(await fetch(`${API_PREFIX}/donations/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'api',
      base_url: input.baseUrl,
      constraints: {
        quota_usd: input.quotaUsd,
        concurrency: 2,
        interval_minutes: input.intervalMinutes,
        expires_in_days: 30,
      },
    }),
    signal: input.signal,
  }))
  return json<DonationReceipt>(await fetch(`${API_PREFIX}/donations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quote_token: quote.quote_token,
      api_key: input.apiKey,
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
  return json<RegistryProposalReceipt>(await fetch(`${API_PREFIX}/registry/proposals`, {
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
