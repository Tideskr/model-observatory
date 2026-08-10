import { Type, type Static } from '@sinclair/typebox'
import { ApiMetaSchema, EvidenceSourceSchema } from './common.js'

const SourceNumbersSchema = Type.Object(
  { vendor: Type.Union([Type.Integer(), Type.Null()]), donated: Type.Union([Type.Integer(), Type.Null()]), community: Type.Union([Type.Integer(), Type.Null()]) },
  { additionalProperties: false },
)
const SourceSamplesSchema = Type.Object(
  { vendor: Type.Integer(), donated: Type.Integer(), community: Type.Integer() },
  { additionalProperties: false },
)
const ModelEntrySchema = Type.Object(
  { model: Type.String(), bySource: SourceNumbersSchema, samples: SourceSamplesSchema },
  { additionalProperties: false },
)
const ProviderGroupSchema = Type.Object(
  {
    id: Type.String(),
    kind: Type.Union([Type.Literal('none'), Type.Literal('price'), Type.Literal('tier')]),
    label: Type.String(),
    multiplier: Type.Optional(Type.Number()),
    models: Type.Array(ModelEntrySchema),
  },
  { additionalProperties: false },
)
const AnomalySchema = Type.Object(
  {
    id: Type.String(), at: Type.String({ format: 'date-time' }), channel: Type.String(), source: EvidenceSourceSchema,
    model: Type.String(), groupId: Type.Optional(Type.String()), probeId: Type.String(), expected: Type.String(),
    observed: Type.String(), severity: Type.Union([Type.Literal('hard'), Type.Literal('soft')]),
  },
  { additionalProperties: false },
)
export const ProviderSchema = Type.Object(
  {
    slug: Type.String(), name: Type.String(),
    kind: Type.Union([Type.Literal('relay'), Type.Literal('official'), Type.Literal('official_proxy')]),
    endpoint: Type.String(), lastCheckedAt: Type.String({ format: 'date-time' }), history: Type.Array(Type.Integer()),
    groups: Type.Array(ProviderGroupSchema), anomalies: Type.Array(AnomalySchema),
  },
  { additionalProperties: false },
)
export type PublicProvider = Static<typeof ProviderSchema>

export const DashboardResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      providers: Type.Array(ProviderSchema),
      source_policy: Type.Object(
        {
          headline_sources: Type.Tuple([Type.Literal('donated'), Type.Literal('community')]),
          excluded_sources: Type.Tuple([Type.Literal('vendor')]),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
])

export const ProviderResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object({ provider: ProviderSchema }, { additionalProperties: false }),
])

export const RegistryItemSchema = Type.Object(
  {
    id: Type.String(), category: Type.String(), prompt_template: Type.String(), prompt_sha256: Type.String(),
    developer_message: Type.Optional(Type.String()), scoring_kind: Type.String(), prompt_rewrite_allowed: Type.Boolean(),
    status: Type.Union([Type.Literal('stable'), Type.Literal('beta')]), metadata: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
)
export type PublicRegistryItem = Static<typeof RegistryItemSchema>

export const RegistryResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object({ release_id: Type.String(), status: Type.String(), items: Type.Array(RegistryItemSchema) }, { additionalProperties: false }),
])
