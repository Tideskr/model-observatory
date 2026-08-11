import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { AppConfig } from '../config.js'
import {
  DONATION_DISCLOSURE_VERSION,
  DonationCreateRequestSchema,
  DonationCreateResponseSchema,
  DonationQuoteRequestSchema,
  DonationQuoteResponseSchema,
  DonationStatusResponseSchema,
  RegistryProposalRequestSchema,
  RegistryProposalResponseSchema,
  type RegistryProposalRequest,
} from '../contracts/contributions.js'
import { apiMeta, TERMINAL_RUN_STATUSES } from '../contracts/common.js'
import { AppError } from '../errors.js'
import { assertSafeTargetHostname } from '../executor/ssrf.js'
import { donationModelEstimate } from '../domain/donation-plan.js'
import { deriveDonationRevocationCapability, verifyCapability } from '../security/capability.js'
import { issueDonationQuote, verifyDonationQuote } from '../security/donation-quote.js'
import type { AppServices } from '../services.js'
import type { DonationRecord, RegistryProposalRecord } from '../store/contribution-store.js'

interface ContributionRouteOptions { config: AppConfig; services: AppServices }

const IdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) }, { additionalProperties: false })
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
    const input = value.trim()
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
  } catch {
    throw new AppError(400, 'invalid_target', 'base_url must be a valid HTTPS URL or hostname.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'invalid_target', 'base_url must use HTTPS and cannot contain credentials, query parameters, or fragments.')
  }
  if (url.port && url.port !== '443') throw new AppError(400, 'target_port_blocked', 'Donated API endpoints only permit HTTPS port 443.')
  assertSafeTargetHostname(url.hostname)
  const path = url.pathname.replace(/\/+$/, '')
  return { origin: url.origin, baseUrl: `${url.origin}${path}`, hostname: url.hostname }
}

function bearer(value: string): string {
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(value)
  if (!match?.[1]) throw new AppError(401, 'revocation_token_required', 'A donation revocation token is required.')
  return match[1]
}

async function ownedDonation(id: string, authorization: string, config: AppConfig, services: AppServices): Promise<DonationRecord> {
  let donation = await services.contributionStore.getDonation(id)
  if (!donation || !verifyCapability(bearer(authorization), donation.revocationTokenHash, 'donation-revocation', config.tokenPepper)) {
    throw new AppError(404, 'donation_not_found', 'The donation does not exist.')
  }
  if (donation.status !== 'revoked' && donation.status !== 'expired' && new Date(donation.expiresAt).getTime() <= Date.now()) {
    await cancelDonationRuns(donation.id, services)
    donation = await services.contributionStore.expireDonation(donation.id)
    await services.credentialVault.delete(donation.credentialHandle)
  }
  return donation
}

async function cancelDonationRuns(donationId: string, services: AppServices): Promise<void> {
  const pendingRuns = (await services.contributionStore.listPendingDonationRuns()).filter((item) => item.donationId === donationId)
  for (const link of pendingRuns) {
    const run = await services.runStore.get(link.privateRunId)
    if (!run) continue
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      try { await services.runStore.transition(run.id, 'cancelled', 'cancelled', { reason: 'donation_ended' }) }
      catch (error) { if (!(error instanceof AppError) || error.code !== 'invalid_run_transition') throw error }
    }
    await services.credentialVault.delete(run.credentialHandle)
  }
}

function fingerprintTail(apiKey: string, pepper: string): string {
  return createHmac('sha256', pepper).update('model-observatory:credential-fingerprint:').update(apiKey).digest('hex').slice(-10)
}

function donationRequestDigest(quoteToken: string, apiKey: string, groupId: string, disclosureVersion: string, pepper: string): string {
  const keyDigest = createHmac('sha256', pepper).update('donation-credential-digest:').update(apiKey).digest('hex')
  return createHash('sha256').update(quoteToken).update(':').update(keyDigest).update(':').update(groupId).update(':').update(disclosureVersion).digest('hex')
}

function validateEvidenceUrls(values: string[]): void {
  for (const value of values) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new AppError(400, 'invalid_evidence_url', 'Evidence URLs must be absolute HTTPS URLs.')
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new AppError(400, 'invalid_evidence_url', 'Evidence URLs must be absolute HTTPS URLs without credentials.')
    }
  }
}

function proposalContent(value: RegistryProposalRequest): string {
  return JSON.stringify({
    probe_id: value.probe_id,
    field: value.field,
    current_value: value.current_value,
    proposed_value: value.proposed_value,
    reason: value.reason,
    evidence_urls: value.evidence_urls,
  })
}

function issueUrl(config: AppConfig, proposal: RegistryProposalRequest, contentSha256: string): string {
  const body = [
    '<!-- Generated by Model Observatory. Keep the machine-readable block. -->',
    '',
    '```yaml',
    `probe_id: ${proposal.probe_id}`,
    `field: ${proposal.field}`,
    `current: ${JSON.stringify(proposal.current_value)}`,
    `proposed: ${JSON.stringify(proposal.proposed_value)}`,
    `content_sha256: ${contentSha256}`,
    '```',
    '',
    '### Reason and evidence',
    '',
    proposal.reason,
    ...proposal.evidence_urls.map((url) => `- ${url}`),
  ].join('\n')
  const query = new URLSearchParams({
    template: 'probe-change.yml',
    title: `probe(${proposal.probe_id}): change ${proposal.field}`,
    body,
  })
  return `${config.repositoryUrl}/issues/new?${query.toString()}`
}

function donationResponse(record: DonationRecord, services: AppServices) {
  const provider = services.providerRegistry.document.providers.find((item) => item.slug === record.providerSlug)
  const group = provider?.groups.find((item) => item.id === record.groupId)
  if (!provider || !group) throw new AppError(500, 'provider_registry_drift', 'The donation references an unavailable provider group.')
  const remaining = Math.max(0, record.constraints.quota_usd - record.quotaSpentUsd - record.quotaReservedUsd)
  return {
    ...apiMeta(), donation_id: record.id, kind: record.kind, status: record.status,
    target_origin: record.targetOrigin, target_base_url: record.targetBaseUrl,
    provider: { slug: provider.slug, name: provider.name },
    group: { id: group.id, name: group.name, multiplier: group.multiplier, models: group.models },
    detected_group_id: record.detectedGroupId, group_attribution: record.groupAttribution,
    phase: record.phase, progress_current: record.progressCurrent, progress_total: record.progressTotal,
    current_model: record.currentModel, next_run_at: record.nextRunAt, last_checked_at: record.lastCheckedAt,
    quota: { limit_usd: record.constraints.quota_usd, spent_usd: record.quotaSpentUsd, reserved_usd: record.quotaReservedUsd, remaining_usd: remaining },
    errors: record.errors,
    constraints: record.constraints, credential_fingerprint_tail: record.credentialFingerprintTail,
    created_at: record.createdAt, expires_at: record.expiresAt, revoked_at: record.revokedAt,
  }
}

function proposalResponse(record: RegistryProposalRecord) {
  return {
    ...apiMeta(), proposal_id: record.id, status: record.status, content_sha256: record.contentSha256,
    issue_url: record.issueUrl, created_at: record.createdAt,
  }
}

export const contributionRoutes: FastifyPluginAsyncTypebox<ContributionRouteOptions> = async (app, options) => {
  const { config, services } = options

  app.post(
    '/donations/quote',
    {
      schema: { tags: ['donations'], body: DonationQuoteRequestSchema, response: { 200: DonationQuoteResponseSchema } },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => {
      const target = normalizeTarget(request.body.base_url)
      const provider = services.providerRegistry.findByHostname(target.hostname)
      if (!provider) throw new AppError(404, 'provider_not_registered', 'This API hostname is not registered to a provider.')
      if (provider.groups.length === 0) throw new AppError(409, 'provider_groups_unconfigured', 'This provider does not have any configured detection groups yet.')
      if (request.body.group_id && !provider.groups.some((item) => item.id === request.body.group_id)) {
        throw new AppError(400, 'provider_group_not_found', 'The selected group does not belong to this provider.')
      }
      const { quote, token } = issueDonationQuote(
        {
          kind: request.body.kind, targetOrigin: target.origin, targetBaseUrl: target.baseUrl,
          targetHostname: target.hostname, constraints: request.body.constraints,
          providerSlug: provider.slug,
        },
        config.quoteSigningSecret,
        config.quoteTtlSeconds,
      )
      return {
        ...apiMeta(), quote_id: quote.quoteId, quote_token: token, kind: quote.kind,
        target_origin: quote.targetOrigin, target_base_url: quote.targetBaseUrl, target_hostname: quote.targetHostname,
        provider: { slug: provider.slug, name: provider.name, kind: provider.kind },
        groups: provider.groups.map((group) => {
          const estimate = donationModelEstimate({
            input_per_million: services.providerRegistry.document.pricing.input_per_million_usd,
            output_per_million: services.providerRegistry.document.pricing.output_per_million_usd,
            multiplier: group.multiplier,
          })
          return {
            id: group.id, name: group.name, multiplier: group.multiplier, models: group.models,
            requests_per_model: estimate.requests,
            estimated_cost_usd: Number((estimate.estimated_cost_usd * group.models.length).toFixed(6)),
            maximum_cost_usd: Number((estimate.maximum_cost_usd * group.models.length).toFixed(6)),
          }
        }),
        constraints: quote.constraints, disclosure_version: DONATION_DISCLOSURE_VERSION,
        initial_status: 'quarantined' as const,
        credential_treatment: {
          storage: 'aes-256-gcm-envelope' as const, raw_value_in_business_record: false as const,
          deletion: 'on-revoke-or-expiry' as const,
        },
        expires_at: quote.expiresAt,
      }
    },
  )

  app.post(
    '/donations',
    {
      schema: { tags: ['donations'], headers: CreateHeadersSchema, body: DonationCreateRequestSchema, response: { 202: DonationCreateResponseSchema } },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const quote = verifyDonationQuote(request.body.quote_token, config.quoteSigningSecret)
      const provider = services.providerRegistry.document.providers.find((item) => item.slug === quote.providerSlug)
      const group = provider?.groups.find((item) => item.id === request.body.group_id)
      if (!provider || !group) throw new AppError(409, 'provider_registry_changed', 'The provider group changed after this quote was issued. Request a new quote.')
      const acceptedAt = new Date(request.body.consent.accepted_at).getTime()
      const now = Date.now()
      if (!Number.isFinite(acceptedAt) || acceptedAt > now + 30_000 || acceptedAt < now - 5 * 60_000) {
        throw new AppError(400, 'invalid_consent', 'Consent must be recorded during the current session.')
      }
      const idempotencyKey = request.headers['idempotency-key']
      const id = randomUUID()
      const revocation = deriveDonationRevocationCapability(id, idempotencyKey, config.tokenPepper)
      const expiresAt = new Date(now + quote.constraints.expires_in_days * 24 * 60 * 60 * 1000)
      const credentialHandle = await services.credentialVault.put(request.body.api_key, `donation:${id}`, expiresAt)
      const record: DonationRecord = {
        id, quoteId: quote.quoteId,
        requestDigest: donationRequestDigest(request.body.quote_token, request.body.api_key, request.body.group_id, request.body.consent.disclosure_version, config.tokenPepper),
        idempotencyKey, kind: 'api', status: 'quarantined', targetOrigin: quote.targetOrigin, targetBaseUrl: quote.targetBaseUrl,
        targetHostname: quote.targetHostname, constraints: quote.constraints, credentialHandle,
        providerSlug: provider.slug, groupId: group.id, detectedGroupId: null, groupAttribution: 'pending',
        phase: 'queued', progressCurrent: 0, progressTotal: group.models.length * 64,
        currentModel: null, nextRunAt: new Date(now).toISOString(), lastCheckedAt: null,
        quotaSpentUsd: 0, quotaReservedUsd: 0, errors: [],
        credentialFingerprintTail: fingerprintTail(request.body.api_key, config.tokenPepper),
        revocationTokenHash: revocation.hash, disclosureVersion: quote.disclosureVersion,
        createdAt: new Date(now).toISOString(), expiresAt: expiresAt.toISOString(), revokedAt: null,
      }
      try {
        const result = await services.contributionStore.createDonation(record)
        if (!result.created) await services.credentialVault.delete(credentialHandle)
        request.body.api_key = ''
        const owner = deriveDonationRevocationCapability(result.record.id, idempotencyKey, config.tokenPepper)
        void reply.status(202)
        return {
          ...apiMeta(), donation_id: result.record.id, status: result.record.status,
          credential_fingerprint_tail: result.record.credentialFingerprintTail,
          revocation_token: owner.token, revocation_token_tail: owner.tail,
          status_url: `/api/v1/donations/${result.record.id}/status`, expires_at: result.record.expiresAt,
        }
      } catch (error) {
        await services.credentialVault.delete(credentialHandle)
        throw error
      }
    },
  )

  app.get(
    '/donations/:id/status',
    { schema: { tags: ['donations'], params: IdParamsSchema, headers: AuthorizationHeadersSchema, response: { 200: DonationStatusResponseSchema } } },
    async (request) => donationResponse(await ownedDonation(request.params.id, request.headers.authorization, config, services), services),
  )

  app.post(
    '/donations/:id/revoke',
    { schema: { tags: ['donations'], params: IdParamsSchema, headers: AuthorizationHeadersSchema, response: { 200: DonationStatusResponseSchema } } },
    async (request) => {
      const donation = await ownedDonation(request.params.id, request.headers.authorization, config, services)
      await cancelDonationRuns(donation.id, services)
      const revoked = await services.contributionStore.revokeDonation(donation.id, new Date().toISOString())
      await services.credentialVault.delete(donation.credentialHandle)
      return donationResponse(revoked, services)
    },
  )

  app.post(
    '/registry/proposals',
    {
      schema: { tags: ['registry'], body: RegistryProposalRequestSchema, response: { 202: RegistryProposalResponseSchema } },
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      validateEvidenceUrls(request.body.evidence_urls)
      const [stable, beta] = await Promise.all([
        services.publicRepository.listRegistry('stable'), services.publicRepository.listRegistry('beta'),
      ])
      const probe = [...stable.items, ...beta.items].find((item) => item.id === request.body.probe_id)
      if (!probe) throw new AppError(404, 'probe_not_found', 'The scoring probe does not exist.')
      if (request.body.field === 'prompt_template' && !probe.prompt_rewrite_allowed) {
        throw new AppError(409, 'prompt_pinned', 'This calibrated prompt is hash-pinned and cannot be rewritten in place.')
      }
      if (request.body.field === 'prompt_template' && request.body.current_value !== probe.prompt_template) {
        throw new AppError(409, 'proposal_stale', 'The proposal was based on an outdated prompt value.')
      }
      const contentSha256 = createHash('sha256').update(proposalContent(request.body)).digest('hex')
      const record: RegistryProposalRecord = {
        id: randomUUID(), probeId: request.body.probe_id, field: request.body.field,
        currentValue: request.body.current_value, proposedValue: request.body.proposed_value,
        reason: request.body.reason, evidenceUrls: [...request.body.evidence_urls], contentSha256,
        status: 'gitops_pending', issueUrl: issueUrl(config, request.body, contentSha256), createdAt: new Date().toISOString(),
      }
      await services.contributionStore.createProposal(record)
      void reply.status(202)
      return proposalResponse(record)
    },
  )

  app.get(
    '/registry/proposals/:id',
    { schema: { tags: ['registry'], params: IdParamsSchema, response: { 200: RegistryProposalResponseSchema } } },
    async (request) => {
      const record = await services.contributionStore.getProposal(request.params.id)
      if (!record) throw new AppError(404, 'proposal_not_found', 'The registry proposal does not exist.')
      return proposalResponse(record)
    },
  )
}
