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
