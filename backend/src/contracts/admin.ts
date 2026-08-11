import { Type } from '@sinclair/typebox'

export const AdminSessionResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  authenticated: Type.Boolean(),
  user: Type.Union([Type.Null(), Type.Object({
    id: Type.Integer(), login: Type.String(), avatar_url: Type.String(),
  }, { additionalProperties: false })]),
  csrf_token: Type.Union([Type.Null(), Type.String()]),
}, { additionalProperties: false })

export const RegistryDraftParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) }, { additionalProperties: false })
export const RegistryVersionParamsSchema = Type.Object({ sha: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false })
export const CreateRegistryDraftSchema = Type.Object({
  source_content_sha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
}, { additionalProperties: false })
export const UpdateRegistryDraftSchema = Type.Object({
  revision: Type.Integer({ minimum: 1 }),
  document: Type.Unknown(),
}, { additionalProperties: false })
export const PublishRegistryDraftSchema = Type.Object({ revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })
export const ValidateRegistrySchema = Type.Object({ document: Type.Unknown() }, { additionalProperties: false })

export const OAuthCallbackQuerySchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 512 }),
  state: Type.String({ minLength: 20, maxLength: 512 }),
}, { additionalProperties: true })
