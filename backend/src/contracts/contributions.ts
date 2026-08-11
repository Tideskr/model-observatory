import { Type, type Static } from '@sinclair/typebox'
import { ApiMetaSchema } from './common.js'

export const DONATION_DISCLOSURE_VERSION = 'donation-api-v1' as const

export const DonationConstraintsSchema = Type.Object(
  {
    quota_usd: Type.Number({ minimum: 1, maximum: 10_000 }),
    concurrency: Type.Integer({ minimum: 1, maximum: 16 }),
    interval_minutes: Type.Integer({ minimum: 30, maximum: 10_080 }),
    expires_in_days: Type.Integer({ minimum: 1, maximum: 90 }),
  },
  { additionalProperties: false },
)
export type DonationConstraints = Static<typeof DonationConstraintsSchema>

export const DonationQuoteRequestSchema = Type.Object(
  {
    kind: Type.Literal('api'),
    base_url: Type.String({ minLength: 1, maxLength: 2048 }),
    constraints: DonationConstraintsSchema,
    group_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)

export const DonationQuoteResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      quote_id: Type.String({ format: 'uuid' }),
      quote_token: Type.String(),
      kind: Type.Literal('api'),
      target_origin: Type.String({ format: 'uri' }),
      target_base_url: Type.String({ format: 'uri' }),
      target_hostname: Type.String(),
      provider: Type.Object({
        slug: Type.String(), name: Type.String(),
        kind: Type.Union([Type.Literal('relay'), Type.Literal('official'), Type.Literal('official_proxy')]),
      }, { additionalProperties: false }),
      groups: Type.Array(Type.Object({
        id: Type.String(), name: Type.String(), multiplier: Type.Number(), models: Type.Array(Type.String()),
        requests_per_model: Type.Integer(), estimated_cost_usd: Type.Number(), maximum_cost_usd: Type.Number(),
      }, { additionalProperties: false })),
      constraints: DonationConstraintsSchema,
      disclosure_version: Type.Literal(DONATION_DISCLOSURE_VERSION),
      initial_status: Type.Literal('quarantined'),
      credential_treatment: Type.Object(
        {
          storage: Type.Literal('aes-256-gcm-envelope'),
          raw_value_in_business_record: Type.Literal(false),
          deletion: Type.Literal('on-revoke-or-expiry'),
        },
        { additionalProperties: false },
      ),
      expires_at: Type.String({ format: 'date-time' }),
    },
    { additionalProperties: false },
  ),
])

export const DonationCreateRequestSchema = Type.Object(
  {
    quote_token: Type.String({ minLength: 64, maxLength: 32_768 }),
    api_key: Type.String({ minLength: 1, maxLength: 4096 }),
    group_id: Type.String({ minLength: 1, maxLength: 128 }),
    consent: Type.Object(
      {
        disclosure_version: Type.Literal(DONATION_DISCLOSURE_VERSION),
        accepted_at: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export const DonationStatusSchema = Type.Union([
  Type.Literal('quarantined'),
  Type.Literal('active'),
  Type.Literal('revoked'),
  Type.Literal('expired'),
  Type.Literal('rejected'),
])
export type DonationStatus = Static<typeof DonationStatusSchema>

export const DonationErrorSchema = Type.Object({
  stage: Type.String(), code: Type.String(), message: Type.String(),
  model: Type.Union([Type.String(), Type.Null()]),
  http_status: Type.Union([Type.Integer(), Type.Null()]),
  retryable: Type.Boolean(), at: Type.String({ format: 'date-time' }),
}, { additionalProperties: false })
export type DonationError = Static<typeof DonationErrorSchema>

export const DonationCreateResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      donation_id: Type.String({ format: 'uuid' }),
      status: DonationStatusSchema,
      credential_fingerprint_tail: Type.String(),
      revocation_token: Type.String(),
      revocation_token_tail: Type.String(),
      status_url: Type.String(),
      expires_at: Type.String({ format: 'date-time' }),
    },
    { additionalProperties: false },
  ),
])

export const DonationStatusResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      donation_id: Type.String({ format: 'uuid' }),
      kind: Type.Literal('api'),
      status: DonationStatusSchema,
      target_origin: Type.String({ format: 'uri' }),
      target_base_url: Type.String({ format: 'uri' }),
      provider: Type.Object({ slug: Type.String(), name: Type.String() }, { additionalProperties: false }),
      group: Type.Object({ id: Type.String(), name: Type.String(), multiplier: Type.Number(), models: Type.Array(Type.String()) }, { additionalProperties: false }),
      detected_group_id: Type.Union([Type.String(), Type.Null()]),
      group_attribution: Type.Union([Type.Literal('pending'), Type.Literal('verified'), Type.Literal('donor_declared')]),
      phase: Type.String(),
      progress_current: Type.Integer(), progress_total: Type.Integer(),
      current_model: Type.Union([Type.String(), Type.Null()]),
      next_run_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
      last_checked_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
      quota: Type.Object({ limit_usd: Type.Number(), spent_usd: Type.Number(), reserved_usd: Type.Number(), remaining_usd: Type.Number() }, { additionalProperties: false }),
      errors: Type.Array(DonationErrorSchema),
      constraints: DonationConstraintsSchema,
      credential_fingerprint_tail: Type.String(),
      created_at: Type.String({ format: 'date-time' }),
      expires_at: Type.String({ format: 'date-time' }),
      revoked_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    },
    { additionalProperties: false },
  ),
])

export const RegistryProposalFieldSchema = Type.Union([
  Type.Literal('label'),
  Type.Literal('scoring_note'),
  Type.Literal('prompt_template'),
  Type.Literal('expected_answer'),
])
export type RegistryProposalField = Static<typeof RegistryProposalFieldSchema>

export const RegistryProposalRequestSchema = Type.Object(
  {
    probe_id: Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-z0-9_:-]+$' }),
    field: RegistryProposalFieldSchema,
    current_value: Type.String({ maxLength: 16_384 }),
    proposed_value: Type.String({ minLength: 1, maxLength: 16_384 }),
    reason: Type.String({ minLength: 20, maxLength: 8_192 }),
    evidence_urls: Type.Array(Type.String({ format: 'uri', maxLength: 2048 }), { maxItems: 5 }),
  },
  { additionalProperties: false },
)
export type RegistryProposalRequest = Static<typeof RegistryProposalRequestSchema>

export const RegistryProposalResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      proposal_id: Type.String({ format: 'uuid' }),
      status: Type.Literal('gitops_pending'),
      content_sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      issue_url: Type.String({ format: 'uri' }),
      created_at: Type.String({ format: 'date-time' }),
    },
    { additionalProperties: false },
  ),
])
