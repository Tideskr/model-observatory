import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { GitHubAdminConfig } from '../config.js'
import type { DatabasePool } from '../db/connection.js'
import { AppError } from '../errors.js'
import { createProviderRegistry, parseProviderRegistry, type ProviderRegistryDocument } from '../registry/catalog.js'
import { syncProviderRegistry } from '../registry/sync.js'
import type { ReloadableProviderRegistry } from '../registry/runtime.js'
import { chainAuditEvent } from '../security/audit-chain.js'
import { GitHubAdminClient, GitHubApiError, type GitHubIdentity } from './github.js'

const SESSION_IDLE_MS = 12 * 60 * 60_000
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000

export interface AdminIdentity extends GitHubIdentity {}

export interface AdminSession {
  identity: AdminIdentity
  csrfToken: string
}

export interface RegistryDraft {
  id: string
  baseBlobSha: string
  baseContentSha256: string
  document: ProviderRegistryDocument
  revision: number
  status: 'draft' | 'publishing' | 'published' | 'committed_pending_activation' | 'superseded'
  createdByLogin: string
  updatedByLogin: string
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  commitSha: string | null
}

interface DraftRow {
  id: string
  base_blob_sha: string
  base_content_sha256: string
  document: unknown
  revision: number
  status: RegistryDraft['status']
  created_by_login: string
  updated_by_login: string
  created_at: Date
  updated_at: Date
  published_at: Date | null
  commit_sha: string | null
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }

function draft(row: DraftRow): RegistryDraft {
  return {
    id: row.id,
    baseBlobSha: row.base_blob_sha,
    baseContentSha256: row.base_content_sha256,
    document: parseProviderRegistry(row.document),
    revision: row.revision,
    status: row.status,
    createdByLogin: row.created_by_login,
    updatedByLogin: row.updated_by_login,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
    commitSha: row.commit_sha,
  }
}

const draftColumns = `id,base_blob_sha,base_content_sha256,document,revision,status,created_by_login,
  updated_by_login,created_at,updated_at,published_at,commit_sha`

export class AdminService {
  readonly github: GitHubAdminClient

  constructor(
    readonly config: GitHubAdminConfig,
    private readonly pool: DatabasePool,
    private readonly registry: ReloadableProviderRegistry,
    github?: GitHubAdminClient,
  ) {
    this.github = github ?? new GitHubAdminClient(config)
  }

  beginOAuth(): { state: string; verifier: string; challenge: string; cookie: string } {
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ state, verifier, expiresAt: Date.now() + 10 * 60_000 })).toString('base64url')
    const signature = createHmac('sha256', this.config.sessionSecret).update(payload).digest('base64url')
    return { state, verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), cookie: `${payload}.${signature}` }
  }

  consumeOAuth(cookie: string | undefined, returnedState: string): { verifier: string } {
    if (!cookie) throw new AppError(401, 'oauth_state_invalid', 'The GitHub authorization state is missing or expired.')
    const [payload, signature, extra] = cookie.split('.')
    if (!payload || !signature || extra) throw new AppError(401, 'oauth_state_invalid', 'The GitHub authorization state is invalid.')
    const expected = createHmac('sha256', this.config.sessionSecret).update(payload).digest()
    let actual: Buffer
    try { actual = Buffer.from(signature, 'base64url') } catch { throw new AppError(401, 'oauth_state_invalid', 'The GitHub authorization state is invalid.') }
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new AppError(401, 'oauth_state_invalid', 'The GitHub authorization state is invalid.')
    let value: { state?: unknown; verifier?: unknown; expiresAt?: unknown }
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof value }
    catch { throw new AppError(401, 'oauth_state_invalid', 'The GitHub authorization state is invalid.') }
    if (value.state !== returnedState || typeof value.verifier !== 'string' || typeof value.expiresAt !== 'number' || value.expiresAt < Date.now()) {
      throw new AppError(401, 'oauth_state_invalid', 'The GitHub authorization state is invalid or expired.')
    }
    return { verifier: value.verifier }
  }

  async completeOAuth(code: string, verifier: string): Promise<{ token: string; session: AdminSession }> {
    const accessToken = await this.github.exchangeCode(code, verifier)
    const identity = await this.github.identity(accessToken)
    if (!this.config.allowedUserIds.has(identity.id)) throw new AppError(403, 'admin_not_allowed', 'This GitHub account is not authorized to manage the registry.')
    return this.createSession(identity)
  }

  async createSession(identity: AdminIdentity): Promise<{ token: string; session: AdminSession }> {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO admin_sessions(token_hash,github_user_id,github_login,github_avatar_url,idle_expires_at,absolute_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sha256(token), identity.id, identity.login, identity.avatarUrl, new Date(now + SESSION_IDLE_MS), new Date(now + SESSION_ABSOLUTE_MS)],
      )
      await appendAudit(client, identity, this.config.sessionSecret, 'admin.session.created', 'admin_session', sha256(token).slice(0, 16), {})
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
    return { token, session: { identity, csrfToken: this.csrfToken(token) } }
  }

  async session(token: string | undefined): Promise<AdminSession | null> {
    if (!token) return null
    const result = await this.pool.query<{
      github_user_id: string; github_login: string; github_avatar_url: string; absolute_expires_at: Date
    }>(
      `UPDATE admin_sessions SET last_seen_at=now(),idle_expires_at=LEAST(absolute_expires_at,now()+interval '12 hours')
       WHERE token_hash=$1 AND idle_expires_at>now() AND absolute_expires_at>now()
       RETURNING github_user_id,github_login,github_avatar_url,absolute_expires_at`,
      [sha256(token)],
    )
    const row = result.rows[0]
    if (!row) return null
    const identity = { id: Number(row.github_user_id), login: row.github_login, avatarUrl: row.github_avatar_url }
    if (!this.config.allowedUserIds.has(identity.id)) return null
    return { identity, csrfToken: this.csrfToken(token) }
  }

  csrfToken(token: string): string {
    return createHmac('sha256', this.config.sessionSecret).update(`csrf:${token}`).digest('base64url')
  }

  verifyCsrf(token: string, value: string | undefined): boolean {
    if (!value) return false
    const expected = Buffer.from(this.csrfToken(token))
    const actual = Buffer.from(value)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  async logout(token: string, identity: AdminIdentity): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM admin_sessions WHERE token_hash=$1', [sha256(token)])
      await appendAudit(client, identity, this.config.sessionSecret, 'admin.session.revoked', 'admin_session', sha256(token).slice(0, 16), {})
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async purgeExpiredSessions(): Promise<number> {
    const result = await this.pool.query('DELETE FROM admin_sessions WHERE idle_expires_at<=now() OR absolute_expires_at<=now()')
    return result.rowCount ?? 0
  }

  async currentRegistry(): Promise<{
    document: ProviderRegistryDocument; contentSha256: string; gitBlobSha: string; gitContentSha256: string; synchronized: boolean
  }> {
    const [snapshot, file] = await Promise.all([Promise.resolve(this.registry.snapshot()), this.github.getRegistryFile()])
    return {
      document: snapshot.document,
      contentSha256: snapshot.contentSha256,
      gitBlobSha: file.blobSha,
      gitContentSha256: file.contentSha256,
      synchronized: snapshot.contentSha256 === file.contentSha256,
    }
  }

  async listDrafts(): Promise<RegistryDraft[]> {
    await this.pool.query(
      `UPDATE provider_registry_drafts SET status='draft',updated_at=now()
       WHERE status='publishing' AND commit_sha IS NULL AND updated_at<now()-interval '10 minutes'`,
    )
    const result = await this.pool.query<DraftRow>(
      `SELECT ${draftColumns} FROM provider_registry_drafts ORDER BY updated_at DESC LIMIT 50`,
    )
    return result.rows.map(draft)
  }

  async getDraft(id: string): Promise<RegistryDraft> {
    const result = await this.pool.query<DraftRow>(`SELECT ${draftColumns} FROM provider_registry_drafts WHERE id=$1`, [id])
    if (!result.rows[0]) throw new AppError(404, 'registry_draft_not_found', 'The registry draft does not exist.')
    return draft(result.rows[0])
  }

  async createDraft(identity: AdminIdentity, sourceContentSha256?: string): Promise<RegistryDraft> {
    const file = await this.github.getRegistryFile()
    let document = file.document
    if (sourceContentSha256) {
      const version = await this.pool.query<{ document: unknown }>(
        'SELECT document FROM provider_registry_versions WHERE content_sha256=$1 AND document IS NOT NULL', [sourceContentSha256],
      )
      if (!version.rows[0]) throw new AppError(404, 'registry_version_not_found', 'The registry version does not exist.')
      document = parseProviderRegistry(version.rows[0].document)
    }
    const id = randomUUID()
    const result = await this.pool.query<DraftRow>(
      `INSERT INTO provider_registry_drafts
       (id,base_blob_sha,base_content_sha256,document,status,created_by,created_by_login,updated_by,updated_by_login)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$5,$6) RETURNING ${draftColumns}`,
      [id, file.blobSha, file.contentSha256, document, identity.id, identity.login],
    )
    await this.#audit(identity, 'provider_registry.draft.created', 'provider_registry_draft', id, {
      base_content_sha256: file.contentSha256, restored_from: sourceContentSha256 ?? null,
    })
    return draft(result.rows[0]!)
  }

  async updateDraft(id: string, revision: number, document: unknown, identity: AdminIdentity): Promise<RegistryDraft> {
    const registry = createProviderRegistry(parseProviderRegistry(document))
    const result = await this.pool.query<DraftRow>(
      `UPDATE provider_registry_drafts SET document=$1,revision=revision+1,updated_by=$2,updated_by_login=$3,updated_at=now()
       WHERE id=$4 AND revision=$5 AND status='draft' RETURNING ${draftColumns}`,
      [registry.document, identity.id, identity.login, id, revision],
    )
    if (!result.rows[0]) {
      const existing = await this.pool.query<{ status: RegistryDraft['status']; revision: number }>(
        'SELECT status,revision FROM provider_registry_drafts WHERE id=$1', [id],
      )
      if (!existing.rows[0]) throw new AppError(404, 'registry_draft_not_found', 'The registry draft does not exist.')
      if (existing.rows[0].status !== 'draft') throw new AppError(409, 'registry_draft_closed', 'The registry draft has already been published or superseded.')
      throw new AppError(409, 'registry_draft_changed', 'The registry draft was updated elsewhere. Reload it before saving.')
    }
    await this.#audit(identity, 'provider_registry.draft.updated', 'provider_registry_draft', id, {
      revision: result.rows[0].revision, content_sha256: registry.contentSha256,
    })
    return draft(result.rows[0])
  }

  validate(document: unknown): { document: ProviderRegistryDocument; contentSha256: string } {
    const registry = createProviderRegistry(parseProviderRegistry(document))
    return { document: registry.document, contentSha256: registry.contentSha256 }
  }

  async publishDraft(id: string, revision: number, identity: AdminIdentity): Promise<RegistryDraft> {
    const claimed = await this.pool.query<DraftRow>(
      `UPDATE provider_registry_drafts SET status='publishing',updated_at=now()
       WHERE id=$1 AND revision=$2 AND status='draft' RETURNING ${draftColumns}`,
      [id, revision],
    )
    if (!claimed.rows[0]) {
      const existing = await this.pool.query<{ revision: number; status: RegistryDraft['status'] }>(
        'SELECT revision,status FROM provider_registry_drafts WHERE id=$1', [id],
      )
      if (!existing.rows[0]) throw new AppError(404, 'registry_draft_not_found', 'The registry draft does not exist.')
      if (existing.rows[0].revision !== revision) throw new AppError(409, 'registry_draft_changed', 'The registry draft was updated elsewhere. Reload it before publishing.')
      throw new AppError(409, 'registry_draft_closed', 'The registry draft is already publishing or has been closed.')
    }
    const currentDraft = draft(claimed.rows[0])
    const registry = createProviderRegistry(parseProviderRegistry(currentDraft.document))
    let commit
    try {
      const currentFile = await this.github.getRegistryFile()
      if (currentFile.blobSha !== currentDraft.baseBlobSha) {
        await this.#audit(identity, 'provider_registry.publish.conflict', 'provider_registry_draft', id, {
          expected_blob_sha: currentDraft.baseBlobSha, actual_blob_sha: currentFile.blobSha,
        })
        throw new AppError(409, 'registry_base_changed', 'The GitHub registry changed after this draft was created. Create a new draft from the latest version.')
      }
      commit = await this.github.updateRegistryFile(registry.document, currentDraft.baseBlobSha, identity.login)
    } catch (error) {
      await this.pool.query(
        "UPDATE provider_registry_drafts SET status='draft',updated_at=now() WHERE id=$1 AND revision=$2 AND status='publishing'",
        [id, revision],
      )
      if (error instanceof GitHubApiError && error.status === 409) throw new AppError(409, 'registry_base_changed', 'The GitHub registry changed while this draft was publishing.')
      throw error
    }
    const committed = await this.pool.query<DraftRow>(
      `UPDATE provider_registry_drafts
       SET status='committed_pending_activation',commit_sha=$1,published_at=now(),updated_at=now()
       WHERE id=$2 AND revision=$3 AND status='publishing' RETURNING ${draftColumns}`,
      [commit.commitSha, id, revision],
    )
    if (!committed.rows[0]) throw new AppError(409, 'registry_draft_changed', 'The draft state changed after the GitHub commit was created.')
    let status: RegistryDraft['status'] = 'published'
    try {
      await syncProviderRegistry(this.pool, registry, { gitCommitSha: commit.commitSha, activatedBy: `github:${identity.id}` })
    } catch {
      status = 'committed_pending_activation'
    }
    const result = await this.pool.query<DraftRow>(
      `UPDATE provider_registry_drafts SET status=$1,updated_at=now()
       WHERE id=$2 AND revision=$3 AND status IN ('committed_pending_activation','published') RETURNING ${draftColumns}`,
      [status, id, revision],
    )
    if (!result.rows[0]) throw new AppError(409, 'registry_draft_changed', 'The draft state changed while it was publishing.')
    await this.#audit(identity, status === 'published' ? 'provider_registry.published' : 'provider_registry.committed_pending_activation', 'provider_registry_draft', id, {
      content_sha256: registry.contentSha256, commit_sha: commit.commitSha,
    })
    return draft(result.rows[0])
  }

  async versions(): Promise<Array<{
    contentSha256: string; schemaVersion: number; importedAt: string; gitCommitSha: string | null; activatedBy: string | null; active: boolean
  }>> {
    const result = await this.pool.query<{
      content_sha256: string; schema_version: number; imported_at: Date; git_commit_sha: string | null; activated_by: string | null; active: boolean
    }>(
      `SELECT v.content_sha256,v.schema_version,v.imported_at,v.git_commit_sha,v.activated_by,
        (s.content_sha256=v.content_sha256) AS active
       FROM provider_registry_versions v LEFT JOIN provider_registry_state s ON s.singleton=true
       WHERE v.document IS NOT NULL ORDER BY v.imported_at DESC LIMIT 100`,
    )
    return result.rows.map((row) => ({
      contentSha256: row.content_sha256, schemaVersion: row.schema_version, importedAt: row.imported_at.toISOString(),
      gitCommitSha: row.git_commit_sha, activatedBy: row.activated_by, active: row.active,
    }))
  }

  async version(contentSha256: string): Promise<ProviderRegistryDocument> {
    const result = await this.pool.query<{ document: unknown }>(
      'SELECT document FROM provider_registry_versions WHERE content_sha256=$1 AND document IS NOT NULL', [contentSha256],
    )
    if (!result.rows[0]) throw new AppError(404, 'registry_version_not_found', 'The registry version does not exist.')
    return parseProviderRegistry(result.rows[0].document)
  }

  async #audit(identity: AdminIdentity, action: string, subjectType: string, subjectId: string, payload: Record<string, unknown>): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await appendAudit(client, identity, this.config.sessionSecret, action, subjectType, subjectId, payload)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}

async function appendAudit(
  client: PoolClient,
  identity: AdminIdentity,
  secret: string,
  action: string,
  subjectType: string,
  subjectId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('model-observatory-audit-chain'))")
  const previous = await client.query<{ event_hash: string }>('SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1')
  const event = chainAuditEvent({
    action, subjectType, subjectId, actorType: 'github_admin',
    actorIdHash: createHmac('sha256', secret).update(String(identity.id)).digest('hex'),
    payload: { ...payload, actor_login: identity.login }, createdAt: new Date().toISOString(),
  }, previous.rows[0]?.event_hash ?? null)
  await client.query(
    `INSERT INTO audit_events(action,subject_type,subject_id,actor_type,actor_id_hash,payload,previous_hash,event_hash,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [event.action, event.subjectType, event.subjectId, event.actorType, event.actorIdHash, event.payload, event.previousHash, event.eventHash, event.createdAt],
  )
}
