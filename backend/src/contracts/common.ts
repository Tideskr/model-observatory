import { Type, type Static } from '@sinclair/typebox'

export const DATA_VERSION = 'observatory-data-v1'
export const METHOD_VERSION = 'legacy-compatible-v1'
export const DISCLOSURE_VERSION = 'remote-normal-v1' as const

export const EvidenceSourceSchema = Type.Union([
  Type.Literal('vendor'),
  Type.Literal('donated'),
  Type.Literal('community'),
])
export type EvidenceSource = Static<typeof EvidenceSourceSchema>

export const RunStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('provisioning'),
  Type.Literal('running'),
  Type.Literal('scoring'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('timed_out'),
  Type.Literal('incomplete'),
  Type.Literal('deleted'),
])
export type RunStatus = Static<typeof RunStatusSchema>

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'incomplete',
  'deleted',
])

export const ApiMetaSchema = Type.Object(
  {
    generated_at: Type.String({ format: 'date-time' }),
    data_version: Type.String(),
    method_version: Type.String(),
  },
  { additionalProperties: false },
)
export type ApiMeta = Static<typeof ApiMetaSchema>

export const ProblemSchema = Type.Object(
  {
    type: Type.String({ format: 'uri-reference' }),
    title: Type.String(),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    detail: Type.String(),
    code: Type.String(),
    request_id: Type.String(),
  },
  { additionalProperties: false },
)
export type Problem = Static<typeof ProblemSchema>

export function apiMeta(now = new Date()): ApiMeta {
  return {
    generated_at: now.toISOString(),
    data_version: DATA_VERSION,
    method_version: METHOD_VERSION,
  }
}
