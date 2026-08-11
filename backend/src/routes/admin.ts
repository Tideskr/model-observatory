import type { FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import {
  AdminSessionResponseSchema, CreateRegistryDraftSchema, OAuthCallbackQuerySchema,
  PublishRegistryDraftSchema, RegistryDraftParamsSchema, RegistryVersionParamsSchema,
  UpdateRegistryDraftSchema, ValidateRegistrySchema,
} from '../contracts/admin.js'
import type { AppConfig } from '../config.js'
import { AppError } from '../errors.js'
import type { AdminIdentity, AdminService, RegistryDraft } from '../admin/service.js'
import type { AppServices } from '../services.js'

interface AdminRouteOptions { config: AppConfig; services: AppServices }

function sessionCookie(config: AppConfig): string { return config.appEnv === 'production' ? '__Host-mo_admin' : 'mo_admin' }
function oauthCookie(config: AppConfig): string { return config.appEnv === 'production' ? '__Host-mo_oauth' : 'mo_oauth' }
function cookieOptions(config: AppConfig, maxAge: number) {
  return { path: '/', httpOnly: true, secure: config.appEnv === 'production', sameSite: 'lax' as const, maxAge }
}

function enabled(services: AppServices): AdminService {
  if (!services.adminService) throw new AppError(404, 'admin_unavailable', 'Registry administration is not configured.')
  return services.adminService
}

async function authenticated(
  request: FastifyRequest,
  config: AppConfig,
  services: AppServices,
  mutation = false,
): Promise<{ admin: AdminService; token: string; identity: AdminIdentity }> {
  const admin = enabled(services)
  const token = request.cookies[sessionCookie(config)]
  const session = await admin.session(token)
  if (!token || !session) throw new AppError(401, 'admin_authentication_required', 'Administrator authentication is required.')
  if (mutation) {
    if (request.headers.origin !== config.publicOrigin) throw new AppError(403, 'admin_origin_invalid', 'The request origin is not allowed.')
    const csrf = request.headers['x-csrf-token']
    if (typeof csrf !== 'string' || !admin.verifyCsrf(token, csrf)) throw new AppError(403, 'admin_csrf_invalid', 'The administrator CSRF token is invalid.')
  }
  return { admin, token, identity: session.identity }
}

function draftResponse(value: RegistryDraft) {
  return {
    id: value.id, base_blob_sha: value.baseBlobSha, base_content_sha256: value.baseContentSha256,
    document: value.document, revision: value.revision, status: value.status,
    created_by_login: value.createdByLogin, updated_by_login: value.updatedByLogin,
    created_at: value.createdAt, updated_at: value.updatedAt, published_at: value.publishedAt, commit_sha: value.commitSha,
  }
}

export const adminRoutes: FastifyPluginAsyncTypebox<AdminRouteOptions> = async (app, options) => {
  const { config, services } = options

  app.addHook('onSend', async (_request, reply) => {
    void reply.header('cache-control', 'no-store')
  })

  app.get('/admin/session', {
    schema: { tags: ['admin'], response: { 200: AdminSessionResponseSchema } }, config: { rateLimit: false },
  }, async (request) => {
    if (!services.adminService) return { enabled: false, authenticated: false, user: null, csrf_token: null }
    const token = request.cookies[sessionCookie(config)]
    const session = await services.adminService.session(token)
    return session
      ? { enabled: true, authenticated: true, user: { id: session.identity.id, login: session.identity.login, avatar_url: session.identity.avatarUrl }, csrf_token: session.csrfToken }
      : { enabled: true, authenticated: false, user: null, csrf_token: null }
  })

  app.get('/admin/auth/github', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (_request, reply) => {
    const admin = enabled(services)
    const flow = admin.beginOAuth()
    void reply.setCookie(oauthCookie(config), flow.cookie, cookieOptions(config, 10 * 60)).redirect(admin.github.authorizationUrl(flow.state, flow.challenge))
  })

  app.get('/admin/auth/github/callback', {
    schema: { querystring: OAuthCallbackQuerySchema }, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const admin = enabled(services)
    const flow = admin.consumeOAuth(request.cookies[oauthCookie(config)], request.query.state)
    void reply.clearCookie(oauthCookie(config), cookieOptions(config, 0))
    const result = await admin.completeOAuth(request.query.code, flow.verifier)
    void reply.setCookie(sessionCookie(config), result.token, cookieOptions(config, 7 * 24 * 60 * 60)).redirect('/admin/registry')
  })

  app.post('/admin/logout', async (request, reply) => {
    const auth = await authenticated(request, config, services, true)
    await auth.admin.logout(auth.token, auth.identity)
    void reply.clearCookie(sessionCookie(config), cookieOptions(config, 0)).status(204).send()
  })

  app.get('/admin/registry', async (request) => {
    const { admin } = await authenticated(request, config, services)
    const current = await admin.currentRegistry()
    return {
      document: current.document, content_sha256: current.contentSha256, git_blob_sha: current.gitBlobSha,
      git_content_sha256: current.gitContentSha256, synchronized: current.synchronized,
    }
  })

  app.get('/admin/registry/drafts', async (request) => {
    const { admin } = await authenticated(request, config, services)
    return { items: (await admin.listDrafts()).map(draftResponse) }
  })

  app.get('/admin/registry/drafts/:id', { schema: { params: RegistryDraftParamsSchema } }, async (request) => {
    const { admin } = await authenticated(request, config, services)
    return draftResponse(await admin.getDraft(request.params.id))
  })

  app.post('/admin/registry/drafts', { schema: { body: CreateRegistryDraftSchema } }, async (request, reply) => {
    const { admin, identity } = await authenticated(request, config, services, true)
    void reply.status(201)
    return draftResponse(await admin.createDraft(identity, request.body.source_content_sha256))
  })

  app.patch('/admin/registry/drafts/:id', {
    schema: { params: RegistryDraftParamsSchema, body: UpdateRegistryDraftSchema },
  }, async (request) => {
    const { admin, identity } = await authenticated(request, config, services, true)
    return draftResponse(await admin.updateDraft(request.params.id, request.body.revision, request.body.document, identity))
  })

  app.post('/admin/registry/drafts/:id/validate', {
    schema: { params: RegistryDraftParamsSchema, body: ValidateRegistrySchema },
  }, async (request) => {
    const { admin } = await authenticated(request, config, services, true)
    const result = admin.validate(request.body.document)
    return { valid: true, content_sha256: result.contentSha256, document: result.document }
  })

  app.post('/admin/registry/drafts/:id/publish', {
    schema: { params: RegistryDraftParamsSchema, body: PublishRegistryDraftSchema },
  }, async (request, reply) => {
    const { admin, identity } = await authenticated(request, config, services, true)
    const result = await admin.publishDraft(request.params.id, request.body.revision, identity)
    if (result.status === 'committed_pending_activation') void reply.status(202)
    return draftResponse(result)
  })

  app.get('/admin/registry/versions', async (request) => {
    const { admin } = await authenticated(request, config, services)
    return { items: (await admin.versions()).map((item) => ({
      content_sha256: item.contentSha256, schema_version: item.schemaVersion, imported_at: item.importedAt,
      git_commit_sha: item.gitCommitSha, activated_by: item.activatedBy, active: item.active,
    })) }
  })

  app.get('/admin/registry/versions/:sha', { schema: { params: RegistryVersionParamsSchema } }, async (request) => {
    const { admin } = await authenticated(request, config, services)
    return { content_sha256: request.params.sha, document: await admin.version(request.params.sha) }
  })
}
