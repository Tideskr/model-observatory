import type { RunStatus } from '../contracts/common.js'
import type { RunConfig } from '../contracts/private-runs.js'

export interface RunRecord {
  id: string
  quoteId: string
  requestDigest: string
  status: RunStatus
  targetOrigin: string
  targetBaseUrl: string
  targetHostname: string
  model: string
  config: RunConfig
  disclosureVersion: string
  scoringReleaseId: string
  ownerTokenHash: string
  idempotencyKey: string
  credentialHandle: string
  createdAt: string
  expiresAt: string
}

export interface RunEvent {
  id: string
  runId: string
  eventType: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface RunReport {
  runId: string
  status: RunStatus
  terminal: boolean
  scoringReleaseId: string
  target: { origin: string; model: string }
  summary: Record<string, unknown>
  observations: Record<string, unknown>[]
  createdAt: string
}

export interface StoredObservation {
  jobId: string
  probeId: string
  profile: string
  status: 'ok' | 'error' | 'cancelled'
  normalizedValue: string | null
  classification: string | null
  hardAnomaly: boolean
  elapsedMs: number | null
  safeError: string | null
  metadata: Record<string, unknown>
}

export interface RunStore {
  create(record: RunRecord): Promise<{ record: RunRecord; created: boolean }>
  get(runId: string): Promise<RunRecord | null>
  transition(runId: string, status: RunStatus, eventType: string, payload?: Record<string, unknown>): Promise<RunRecord>
  listEvents(runId: string, afterId: string): Promise<RunEvent[]>
  appendEvent(runId: string, eventType: string, payload: Record<string, unknown>): Promise<void>
  claimNext(workerId: string, leaseSeconds: number): Promise<RunRecord | null>
  renewLease(runId: string, workerId: string, leaseSeconds: number): Promise<boolean>
  saveObservations(runId: string, observations: StoredObservation[]): Promise<void>
  finalize(runId: string, status: Extract<RunStatus, 'completed' | 'incomplete' | 'failed'>, observations: StoredObservation[], report: RunReport): Promise<RunRecord>
  saveReport(report: RunReport): Promise<void>
  getReport(runId: string): Promise<RunReport | null>
  purge(runId: string): Promise<void>
  purgeExpired(now?: Date): Promise<number>
  close(): Promise<void>
}
