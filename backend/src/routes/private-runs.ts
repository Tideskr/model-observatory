import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { apiMeta, DISCLOSURE_VERSION, TERMINAL_RUN_STATUSES } from '../contracts/common.js'
import {
  PrivateRunCreateRequestSchema,
  PrivateRunCreateResponseSchema,
  PrivateRunQuoteRequestSchema,
  PrivateRunQuoteResponseSchema,
  PrivateRunReportResponseSchema,
  RunMutationResponseSchema,
} from '../contracts/private-runs.js'
import { estimateRun } from '../domain/run-estimate.js'
import { AppError } from '../errors.js'
import { deriveRunOwnerCapability, verifyCapability } from '../security/capability.js'
import { issueQuote, verifyQuote } from '../security/signed-quote.js'
import type { AppServices } from '../services.js'
import type { RunRecord } from '../store/run-store.js'
import type { AppConfig } from '../config.js'
import { assertSafeTargetHostname } from '../executor/ssrf.js'

interface PrivateRunRouteOptions {
  config: AppConfig
  services: AppServices
}

const RunParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) }, { additionalProperties: false })
const AuthorizationHeadersSchema = Type.Object(
  { authorization: Type.String({ minLength: 8, maxLength: 512 }) },
  { additionalProperties: true },
)
const CreateHeadersSchema = Type.Object(
  { 'idempotency-key': Type.String({ minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }) },
  { additionalProperties: true },
)

function normalizeTarget(value: string): { origin: string; baseUrl: string; hostname: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError(400, 'invalid_target', 'base_url must be an absolute HTTPS URL.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'invalid_target', 'base_url must use HTTPS and cannot contain credentials, query parameters, or fragments.')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (url.port && url.port !== '443') throw new AppError(400, 'target_port_blocked', 'Remote execution only permits HTTPS port 443.')
  assertSafeTargetHostname(url.hostname)
  return { origin: url.origin, baseUrl: `${url.origin}${path}`, hostname: url.hostname }
}

function bearer(value: string): string {
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(value)
  if (!match?.[1]) throw new AppError(401, 'owner_token_required', 'A private-run owner token is required.')
  return match[1]
}

async function ownedRun(id: string, authorization: string, config: AppConfig, services: AppServices): Promise<RunRecord> {
  let run = await services.runStore.get(id)
  if (!run || run.status === 'deleted') throw new AppError(404, 'run_not_found', 'The private run does not exist.')
  if (!verifyCapability(bearer(authorization), run.ownerTokenHash, 'run-owner', config.tokenPepper)) {
    throw new AppError(404, 'run_not_found', 'The private run does not exist.')
  }
  if (new Date(run.expiresAt).getTime() <= Date.now()) {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      run = await services.runStore.transition(run.id, 'timed_out', 'timed_out', { reason: 'retention_expired' })
    }
    if (run.status !== 'deleted') await services.runStore.transition(run.id, 'deleted', 'deleted', { reason: 'retention_expired' })
    await services.credentialVault.delete(run.credentialHandle)
    await services.runStore.purge(run.id)
    throw new AppError(404, 'run_not_found', 'The private run does not exist.')
  }
  return run
}

function requestDigest(quoteToken: string, apiKey: string, disclosureVersion: string, pepper: string): string {
  const keyDigest = createHmac('sha256', pepper).update('credential-digest:').update(apiKey).digest('hex')
  return createHash('sha256').update(quoteToken).update(':').update(keyDigest).update(':').update(disclosureVersion).digest('hex')
}

export const privateRunRoutes: FastifyPluginAsyncTypebox<PrivateRunRouteOptions> = async (app, options) => {
  const { config, services } = options

  app.post(
    '/private-runs/quote',
    {
      schema: {
        tags: ['private-runs'],
        body: PrivateRunQuoteRequestSchema,
        response: { 200: PrivateRunQuoteResponseSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      const target = normalizeTarget(request.body.base_url)
      const estimate = estimateRun(request.body.config, request.body.maximum_budget_usd, config.maxRunRequests, request.body.pricing)
      const { quote, token } = issueQuote(
        {
          targetOrigin: target.origin,
          targetBaseUrl: target.baseUrl,
          targetHostname: target.hostname,
          model: request.body.model,
          config: request.body.config,
          estimate,
          scoringReleaseId: config.scoringReleaseId,
        },
        config.quoteSigningSecret,
        config.quoteTtlSeconds,
      )
      return {
        ...apiMeta(),
        quote_id: quote.quoteId,
        quote_token: token,
        target_origin: quote.targetOrigin,
        target_base_url: quote.targetBaseUrl,
        target_hostname: quote.targetHostname,
        model: quote.model,
        config: quote.config,
        estimate: quote.estimate,
        disclosure_version: DISCLOSURE_VERSION,
        retention: { raw_response: 'not_retained' as const, report_hours: config.runRetentionHours },
        expires_at: quote.expiresAt,
      }
    },
  )

  app.post(
    '/private-runs',
    {
      schema: {
        tags: ['private-runs'],
        headers: CreateHeadersSchema,
        body: PrivateRunCreateRequestSchema,
        response: { 202: PrivateRunCreateResponseSchema },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const quote = verifyQuote(request.body.quote_token, config.quoteSigningSecret)
      const acceptedAt = new Date(request.body.consent.accepted_at).getTime()
      const now = Date.now()
      if (!Number.isFinite(acceptedAt) || acceptedAt > now + 30_000 || acceptedAt < now - 5 * 60_000) {
        throw new AppError(400, 'invalid_consent', 'Consent must be recorded during the current session.')
      }
      const idempotencyKey = request.headers['idempotency-key']
      const expiresAt = new Date(now + config.runRetentionHours * 60 * 60 * 1000)
      const proposedRunId = randomUUID()
      const proposedOwner = deriveRunOwnerCapability(proposedRunId, idempotencyKey, config.tokenPepper)
      const credentialHandle = await services.credentialVault.put(request.body.api_key, quote.quoteId, expiresAt)
      const record: RunRecord = {
        id: proposedRunId,
        quoteId: quote.quoteId,
        requestDigest: requestDigest(request.body.quote_token, request.body.api_key, request.body.consent.disclosure_version, config.tokenPepper),
        status: 'queued',
        targetOrigin: quote.targetOrigin,
        targetBaseUrl: quote.targetBaseUrl,
        targetHostname: quote.targetHostname,
        model: quote.model,
        config: quote.config,
        disclosureVersion: quote.disclosureVersion,
        scoringReleaseId: quote.scoringReleaseId,
        ownerTokenHash: proposedOwner.hash,
        idempotencyKey,
        credentialHandle,
        createdAt: new Date(now).toISOString(),
        expiresAt: expiresAt.toISOString(),
        leaseVersion: 0,
      }
      let result
      try {
        result = await services.runStore.create(record)
      } catch (error) {
        await services.credentialVault.delete(credentialHandle)
        throw error
      }
      if (!result.created) await services.credentialVault.delete(credentialHandle)
      request.body.api_key = ''
      const owner = deriveRunOwnerCapability(result.record.id, idempotencyKey, config.tokenPepper)
      void reply.status(202)
      return {
        ...apiMeta(),
        run_id: result.record.id,
        owner_token: owner.token,
        owner_token_tail: owner.tail,
        status: result.record.status,
        events_url: `/api/v1/private-runs/${result.record.id}/events`,
        expires_at: result.record.expiresAt,
      }
    },
  )

  app.get(
    '/private-runs/:id/events',
    {
      schema: { tags: ['private-runs'], params: RunParamsSchema, headers: AuthorizationHeadersSchema },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      let run = await ownedRun(request.params.id, request.headers.authorization, config, services)
      let cursor = typeof request.headers['last-event-id'] === 'string' && /^\d+$/.test(request.headers['last-event-id'])
        ? request.headers['last-event-id']
        : '0'
      reply.hijack()
      const response = reply.raw
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-request-id': request.id,
      })
      const deadline = Date.now() + 25_000
      while (!request.raw.destroyed && Date.now() < deadline) {
        const events = await services.runStore.listEvents(run.id, cursor)
        for (const event of events) {
          response.write(`id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`)
          cursor = event.id
        }
        run = (await services.runStore.get(run.id)) ?? run
        if (TERMINAL_RUN_STATUSES.has(run.status)) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      response.end()
    },
  )

  app.post(
    '/private-runs/:id/cancel',
    {
      schema: {
        tags: ['private-runs'],
        params: RunParamsSchema,
        headers: AuthorizationHeadersSchema,
        response: { 200: RunMutationResponseSchema },
      },
    },
    async (request) => {
      const run = await ownedRun(request.params.id, request.headers.authorization, config, services)
      const updated = TERMINAL_RUN_STATUSES.has(run.status)
        ? run
        : await services.runStore.transition(run.id, 'cancelled', 'cancelled', { reason: 'user_requested' })
      if (!(await services.runStore.getReport(run.id)) && updated.status === 'cancelled') {
        const observations = await services.runStore.listObservations(run.id)
        try {
          await services.runStore.saveReport({
            runId: run.id,
            status: 'cancelled',
            terminal: true,
            scoringReleaseId: run.scoringReleaseId,
            target: { origin: run.targetOrigin, model: run.model },
            summary: { reason: 'user_requested', completed_requests: observations.length },
            observations: observations.map((item) => ({
              job_id: item.jobId, probe_id: item.probeId, profile: item.profile, status: item.status,
              normalized_value: item.normalizedValue, classification: item.classification,
              hard_anomaly: item.hardAnomaly, elapsed_ms: item.elapsedMs, safe_error: item.safeError,
              metadata: item.metadata,
            })),
            createdAt: new Date().toISOString(),
          })
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'report_exists') throw error
        }
      }
      await services.credentialVault.delete(run.credentialHandle)
      return { ...apiMeta(), run_id: run.id, status: updated.status }
    },
  )

  app.get(
    '/private-runs/:id/report',
    {
      schema: {
        tags: ['private-runs'],
        params: RunParamsSchema,
        headers: AuthorizationHeadersSchema,
        response: { 200: PrivateRunReportResponseSchema },
      },
    },
    async (request) => {
      await ownedRun(request.params.id, request.headers.authorization, config, services)
      const report = await services.runStore.getReport(request.params.id)
      if (!report) throw new AppError(409, 'report_not_ready', 'The private-run report is not ready.')
      return {
        ...apiMeta(),
        run_id: report.runId,
        status: report.status,
        terminal: report.terminal,
        scoring_release_id: report.scoringReleaseId,
        target: report.target,
        summary: report.summary,
        observations: report.observations,
        created_at: report.createdAt,
      }
    },
  )

  app.delete(
    '/private-runs/:id',
    {
      schema: { tags: ['private-runs'], params: RunParamsSchema, headers: AuthorizationHeadersSchema },
    },
    async (request, reply) => {
      const run = await ownedRun(request.params.id, request.headers.authorization, config, services)
      if (!TERMINAL_RUN_STATUSES.has(run.status)) throw new AppError(409, 'run_not_terminal', 'Cancel the run before deleting it.')
      await services.runStore.transition(run.id, 'deleted', 'deleted')
      await services.credentialVault.delete(run.credentialHandle)
      await services.runStore.purge(run.id)
      return reply.status(204).send()
    },
  )
}
