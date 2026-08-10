import { Type, type Static } from '@sinclair/typebox'
import { ApiMetaSchema, DISCLOSURE_VERSION, RunStatusSchema } from './common.js'

export const ProbeIdSchema = Type.Union([
  Type.Literal('juice_low'),
  Type.Literal('juice_medium'),
  Type.Literal('juice_high'),
  Type.Literal('juice_xhigh'),
  Type.Literal('juice_max'),
  Type.Literal('output_luna_48'),
  Type.Literal('output_terra_32'),
  Type.Literal('juice_coverage'),
  Type.Literal('rand_country'),
  Type.Literal('rand_bird'),
  Type.Literal('b80_letter_count'),
])
export type ProbeId = Static<typeof ProbeIdSchema>

export const ScoredModelSchema = Type.Union([
  Type.Literal('gpt-5.6-sol'),
  Type.Literal('gpt-5.6-terra'),
  Type.Literal('gpt-5.6-luna'),
])

export const ProbeSelectionSchema = Type.Object(
  {
    probe_id: ProbeIdSchema,
    requests: Type.Integer({ minimum: 1, maximum: 100 }),
  },
  { additionalProperties: false },
)

export const RunConfigSchema = Type.Object(
  {
    probes: Type.Array(ProbeSelectionSchema, { minItems: 1, maxItems: 11 }),
    formats: Type.Tuple([Type.Literal('normal')]),
    contexts: Type.Tuple([Type.Literal('no_history')]),
    workers: Type.Integer({ minimum: 1, maximum: 16 }),
    retries: Type.Integer({ minimum: 0, maximum: 3 }),
  },
  { additionalProperties: false },
)
export type RunConfig = Static<typeof RunConfigSchema>

export const RunEstimateSchema = Type.Object(
  {
    requests: Type.Integer(),
    long_context_requests: Type.Integer(),
    input_tokens: Type.Integer(),
    output_tokens: Type.Integer(),
    estimated_seconds: Type.Integer(),
    estimated_cost_usd: Type.Number(),
    maximum_cost_usd: Type.Number(),
  },
  { additionalProperties: false },
)
export type RunEstimate = Static<typeof RunEstimateSchema>

export const PrivateRunQuoteRequestSchema = Type.Object(
  {
    base_url: Type.String({ minLength: 1, maxLength: 2048 }),
    model: ScoredModelSchema,
    config: RunConfigSchema,
    maximum_budget_usd: Type.Number({ minimum: 0.01, maximum: 1000 }),
  },
  { additionalProperties: false },
)
export type PrivateRunQuoteRequest = Static<typeof PrivateRunQuoteRequestSchema>

export const PrivateRunQuoteResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      quote_id: Type.String({ format: 'uuid' }),
      quote_token: Type.String(),
      target_origin: Type.String({ format: 'uri' }),
      target_base_url: Type.String({ format: 'uri' }),
      target_hostname: Type.String(),
      model: Type.String(),
      config: RunConfigSchema,
      estimate: RunEstimateSchema,
      disclosure_version: Type.Literal(DISCLOSURE_VERSION),
      retention: Type.Object(
        {
          raw_response: Type.Literal('not_retained'),
          report_hours: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      expires_at: Type.String({ format: 'date-time' }),
    },
    { additionalProperties: false },
  ),
])

export const PrivateRunCreateRequestSchema = Type.Object(
  {
    quote_token: Type.String({ minLength: 64, maxLength: 32_768 }),
    api_key: Type.String({ minLength: 1, maxLength: 4096 }),
    consent: Type.Object(
      {
        disclosure_version: Type.Literal(DISCLOSURE_VERSION),
        accepted_at: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type PrivateRunCreateRequest = Static<typeof PrivateRunCreateRequestSchema>

export const PrivateRunCreateResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      run_id: Type.String({ format: 'uuid' }),
      owner_token: Type.String(),
      owner_token_tail: Type.String(),
      status: RunStatusSchema,
      events_url: Type.String(),
      expires_at: Type.String({ format: 'date-time' }),
    },
    { additionalProperties: false },
  ),
])

export const RunMutationResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      run_id: Type.String({ format: 'uuid' }),
      status: RunStatusSchema,
    },
    { additionalProperties: false },
  ),
])

export const PrivateRunReportResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      run_id: Type.String({ format: 'uuid' }),
      status: RunStatusSchema,
      terminal: Type.Boolean(),
      scoring_release_id: Type.String(),
      target: Type.Object({ origin: Type.String(), model: Type.String() }, { additionalProperties: false }),
      summary: Type.Record(Type.String(), Type.Unknown()),
      observations: Type.Array(Type.Record(Type.String(), Type.Unknown())),
      created_at: Type.String({ format: 'date-time' }),
    },
    { additionalProperties: false },
  ),
])
