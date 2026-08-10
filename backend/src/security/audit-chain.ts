import { createHash } from 'node:crypto'

export interface AuditEventInput {
  action: string
  subjectType: string
  subjectId: string
  actorType: string
  actorIdHash?: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface ChainedAuditEvent extends AuditEventInput {
  previousHash: string | null
  eventHash: string
}

function canonical(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

export function chainAuditEvent(input: AuditEventInput, previousHash: string | null): ChainedAuditEvent {
  const eventHash = createHash('sha256').update(canonical({ ...input, previousHash })).digest('hex')
  return { ...input, previousHash, eventHash }
}
