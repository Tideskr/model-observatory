import { createSign } from 'node:crypto'
import type { GitHubAdminConfig } from '../config.js'
import { AppError } from '../errors.js'
import { createProviderRegistry, parseProviderRegistry, type ProviderRegistryDocument } from '../registry/catalog.js'

const API_VERSION = '2022-11-28'

export class GitHubApiError extends AppError {
  constructor(public readonly status: number, message: string) {
    super(status === 409 ? 409 : 502, status === 409 ? 'github_conflict' : 'github_unavailable', `GitHub request failed: ${message}`)
    this.name = 'GitHubApiError'
  }
}

export interface GitHubIdentity {
  id: number
  login: string
  avatarUrl: string
}

export interface GitHubRegistryFile {
  blobSha: string
  document: ProviderRegistryDocument
  contentSha256: string
}

export interface GitHubCommitResult { commitSha: string; contentSha: string }

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned an invalid response`)
  return value as Record<string, unknown>
}

export class GitHubAdminClient {
  #installationToken: { value: string; expiresAt: number } | null = null

  constructor(
    private readonly config: GitHubAdminConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  authorizationUrl(state: string, codeChallenge: string): string {
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    return `https://github.com/login/oauth/authorize?${query.toString()}`
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const response = await this.request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.callbackUrl,
        code_verifier: codeVerifier,
      }),
    })
    const body = object(await response.json(), 'GitHub OAuth')
    const token = body['access_token']
    if (!response.ok || typeof token !== 'string') {
      throw new GitHubApiError(response.status, String(body['error_description'] ?? body['error'] ?? 'GitHub OAuth failed'))
    }
    return token
  }

  async identity(accessToken: string): Promise<GitHubIdentity> {
    const response = await this.request('https://api.github.com/user', { headers: this.#headers(accessToken) })
    const body = object(await response.json(), 'GitHub identity')
    if (!response.ok) throw new GitHubApiError(response.status, String(body['message'] ?? 'GitHub identity lookup failed'))
    if (!Number.isSafeInteger(body['id']) || typeof body['login'] !== 'string') throw new Error('GitHub identity response is invalid')
    return {
      id: body['id'] as number,
      login: body['login'],
      avatarUrl: typeof body['avatar_url'] === 'string' ? body['avatar_url'] : '',
    }
  }

  async getRegistryFile(): Promise<GitHubRegistryFile> {
    const token = await this.#token()
    const response = await this.request(this.#contentsUrl(true), { headers: this.#headers(token) })
    const body = object(await response.json(), 'GitHub contents')
    if (!response.ok) throw new GitHubApiError(response.status, String(body['message'] ?? 'GitHub registry read failed'))
    if (typeof body['sha'] !== 'string' || typeof body['content'] !== 'string' || body['encoding'] !== 'base64') {
      throw new Error('GitHub registry response is invalid')
    }
    const parsed = JSON.parse(Buffer.from(body['content'].replaceAll('\n', ''), 'base64').toString('utf8')) as unknown
    const registry = createProviderRegistry(parseProviderRegistry(parsed))
    return { blobSha: body['sha'], document: registry.document, contentSha256: registry.contentSha256 }
  }

  async updateRegistryFile(document: ProviderRegistryDocument, blobSha: string, actorLogin: string): Promise<GitHubCommitResult> {
    const registry = createProviderRegistry(parseProviderRegistry(document))
    const token = await this.#token()
    const response = await this.request(this.#contentsUrl(false), {
      method: 'PUT',
      headers: { ...this.#headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        message: `chore(registry): publish provider update by @${actorLogin}`,
        content: Buffer.from(`${JSON.stringify(registry.document, null, 2)}\n`).toString('base64'),
        sha: blobSha,
        branch: this.config.branch,
      }),
    })
    const body = object(await response.json(), 'GitHub contents update')
    if (!response.ok) throw new GitHubApiError(response.status, String(body['message'] ?? 'GitHub registry update failed'))
    const commit = object(body['commit'], 'GitHub commit')
    const content = object(body['content'], 'GitHub content')
    if (typeof commit['sha'] !== 'string' || typeof content['sha'] !== 'string') throw new Error('GitHub update response is invalid')
    return { commitSha: commit['sha'], contentSha: content['sha'] }
  }

  #contentsUrl(includeRef: boolean): string {
    const path = this.config.registryPath.split('/').map(encodeURIComponent).join('/')
    const base = `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repository)}/contents/${path}`
    return includeRef ? `${base}?ref=${encodeURIComponent(this.config.branch)}` : base
  }

  #headers(token: string): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': API_VERSION,
      'user-agent': 'model-observatory-admin',
    }
  }

  async #token(): Promise<string> {
    if (this.#installationToken && this.#installationToken.expiresAt > Date.now() + 5 * 60_000) return this.#installationToken.value
    const response = await this.request(`https://api.github.com/app/installations/${this.config.installationId}/access_tokens`, {
      method: 'POST',
      headers: { ...this.#headers(this.#appJwt()), 'content-type': 'application/json' },
      body: JSON.stringify({ repositories: [this.config.repository], permissions: { contents: 'write' } }),
    })
    const body = object(await response.json(), 'GitHub installation token')
    if (!response.ok || typeof body['token'] !== 'string' || typeof body['expires_at'] !== 'string') {
      throw new GitHubApiError(response.status, String(body['message'] ?? 'GitHub installation token failed'))
    }
    this.#installationToken = { value: body['token'], expiresAt: new Date(body['expires_at']).getTime() }
    return body['token']
  }

  #appJwt(): string {
    const now = Math.floor(Date.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.config.appId }))
    const unsigned = `${header}.${payload}`
    const signer = createSign('RSA-SHA256')
    signer.update(unsigned)
    return `${unsigned}.${signer.sign(this.config.privateKey).toString('base64url')}`
  }
}
