import { Type, type Static } from '@sinclair/typebox'
import { ApiMetaSchema } from './common.js'

export const HealthResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      status: Type.Literal('ok'),
      service: Type.Literal('model-observatory-api'),
      version: Type.String(),
      registry_sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    },
    { additionalProperties: false },
  ),
])
export type HealthResponse = Static<typeof HealthResponseSchema>
