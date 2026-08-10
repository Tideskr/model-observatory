import { Type, type Static } from '@sinclair/typebox'
import { ApiMetaSchema } from './common.js'

export const HealthResponseSchema = Type.Intersect([
  ApiMetaSchema,
  Type.Object(
    {
      status: Type.Literal('ok'),
      service: Type.Literal('model-observatory-api'),
      version: Type.String(),
    },
    { additionalProperties: false },
  ),
])
export type HealthResponse = Static<typeof HealthResponseSchema>
