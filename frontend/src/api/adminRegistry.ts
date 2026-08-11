import { apiUrl } from '../config'

export const SCORED_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const

export interface RegistryDomain {
  hostname: string
  role: 'primary' | 'alias'
  default_base_path: string
  status: 'active' | 'retired'
}

export interface RegistryGroup {
  id: string
  name: string
  aliases: string[]
  multiplier: number
  models: string[]
}

export interface RegistryProvider {
  slug: string
  name: string
  kind: 'relay' | 'official' | 'official_proxy'
  domains: RegistryDomain[]
  group_detection: { probe_model: string }
  groups: RegistryGroup[]
}

export interface ProviderRegistryDocument {
  schema_version: 2
  pricing: { input_per_million_usd: number; output_per_million_usd: number }
  providers: RegistryProvider[]
}

export interface AdminSessionResponse {
  enabled: boolean
  authenticated: boolean
  user: { id: number; login: string; avatar_url: string } | null
  csrf_token: string | null
}

export interface RegistryCurrent {
  document: ProviderRegistryDocument
  content_sha256: string
  git_blob_sha: string
  git_content_sha256: string
  synchronized: boolean
}

export type DraftStatus = 'draft' | 'publishing' | 'published' | 'committed_pending_activation' | 'superseded'

export interface RegistryDraft {
  id: string
  base_blob_sha: string
  base_content_sha256: string
  document: ProviderRegistryDocument
  revision: number
  status: DraftStatus
  created_by_login: string
  updated_by_login: string
  created_at: string
  updated_at: string
  published_at: string | null
  commit_sha: string | null
}

export interface RegistryVersion {
  content_sha256: string
  schema_version: number
  imported_at: string
  git_commit_sha: string | null
  activated_by: string | null
  active: boolean
}

interface Problem { detail?: string; code?: string }

export class AdminApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init: RequestInit = {}, csrfToken?: string | null): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body) headers.set('content-type', 'application/json')
  if (csrfToken) headers.set('x-csrf-token', csrfToken)
  const response = await fetch(apiUrl(path), { ...init, headers, credentials: 'same-origin' })
  if (response.ok) return response.status === 204 ? undefined as T : response.json() as Promise<T>
  let problem: Problem = {}
  try { problem = await response.json() as Problem } catch { /* Reverse proxies can return non-JSON failures. */ }
  throw new AdminApiError(response.status, problem.code ?? 'request_failed', problem.detail ?? `请求失败（${response.status}）`)
}

export function adminLoginUrl(): string { return apiUrl('/api/v1/admin/auth/github') }
export function fetchAdminSession(): Promise<AdminSessionResponse> { return request('/api/v1/admin/session') }
export function logoutAdmin(csrf: string): Promise<void> { return request('/api/v1/admin/logout', { method: 'POST' }, csrf) }
export function fetchCurrentRegistry(): Promise<RegistryCurrent> { return request('/api/v1/admin/registry') }
export async function fetchDrafts(): Promise<RegistryDraft[]> { return (await request<{ items: RegistryDraft[] }>('/api/v1/admin/registry/drafts')).items }
export function fetchDraft(id: string): Promise<RegistryDraft> { return request(`/api/v1/admin/registry/drafts/${id}`) }
export function createDraft(csrf: string, sourceContentSha256?: string): Promise<RegistryDraft> {
  return request('/api/v1/admin/registry/drafts', {
    method: 'POST', body: JSON.stringify(sourceContentSha256 ? { source_content_sha256: sourceContentSha256 } : {}),
  }, csrf)
}
export function deleteDraft(id: string, csrf: string): Promise<void> {
  return request(`/api/v1/admin/registry/drafts/${id}`, { method: 'DELETE' }, csrf)
}
export function saveDraft(id: string, revision: number, document: ProviderRegistryDocument, csrf: string): Promise<RegistryDraft> {
  return request(`/api/v1/admin/registry/drafts/${id}`, {
    method: 'PATCH', body: JSON.stringify({ revision, document }),
  }, csrf)
}
export function validateDraft(id: string, document: ProviderRegistryDocument, csrf: string): Promise<{ valid: true; content_sha256: string }> {
  return request(`/api/v1/admin/registry/drafts/${id}/validate`, {
    method: 'POST', body: JSON.stringify({ document }),
  }, csrf)
}
export function publishDraft(id: string, revision: number, csrf: string): Promise<RegistryDraft> {
  return request(`/api/v1/admin/registry/drafts/${id}/publish`, {
    method: 'POST', body: JSON.stringify({ revision }),
  }, csrf)
}
export async function fetchRegistryVersions(): Promise<RegistryVersion[]> {
  return (await request<{ items: RegistryVersion[] }>('/api/v1/admin/registry/versions')).items
}
