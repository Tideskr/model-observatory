import { assertRunTransition } from '../domain/run-state.js'
import { AppError } from '../errors.js'
import { LeaseLostError, type RunEvent, type RunLease, type RunRecord, type RunReport, type RunStore, type StoredObservation } from './run-store.js'

export class MemoryRunStore implements RunStore {
  readonly #runs = new Map<string, RunRecord>()
  readonly #idempotency = new Map<string, string>()
  readonly #events = new Map<string, RunEvent[]>()
  readonly #reports = new Map<string, RunReport>()
  readonly #leases = new Map<string, { workerId: string; version: number; expiresAt: number }>()
  readonly #observations = new Map<string, StoredObservation[]>()
  readonly #attempts = new Map<string, Map<string, number>>()
  #eventId = 0n

  async create(record: RunRecord): Promise<{ record: RunRecord; created: boolean }> {
    const existingId = this.#idempotency.get(record.idempotencyKey)
    if (existingId) {
      const existing = this.#runs.get(existingId)
      if (!existing) throw new Error('idempotency index is corrupt')
      if (existing.requestDigest !== record.requestDigest) {
        throw new AppError(409, 'idempotency_conflict', 'The idempotency key was already used for a different request.')
      }
      return { record: structuredClone(existing), created: false }
    }
    this.#runs.set(record.id, structuredClone(record))
    this.#idempotency.set(record.idempotencyKey, record.id)
    this.#events.set(record.id, [])
    this.#recordEvent(record.id, 'status', { status: record.status })
    return { record: structuredClone(record), created: true }
  }

  async get(runId: string): Promise<RunRecord | null> {
    const value = this.#runs.get(runId)
    return value ? structuredClone(value) : null
  }

  #assertLease(runId: string, lease: RunLease): void {
    const current = this.#leases.get(runId)
    if (!current || current.workerId !== lease.workerId || current.version !== lease.version || current.expiresAt <= Date.now()) {
      throw new LeaseLostError()
    }
  }

  #recordEvent(runId: string, eventType: string, payload: Record<string, unknown>): void {
    this.#eventId += 1n
    const events = this.#events.get(runId) ?? []
    events.push({ id: String(this.#eventId), runId, eventType, payload, createdAt: new Date().toISOString() })
    this.#events.set(runId, events)
  }

  #recordObservations(runId: string, observations: StoredObservation[]): void {
    const existing = this.#observations.get(runId) ?? []
    const known = new Set(existing.map((item) => item.jobId))
    for (const observation of observations) {
      if (known.has(observation.jobId)) continue
      known.add(observation.jobId)
      existing.push(structuredClone(observation))
    }
    this.#observations.set(runId, existing)
  }

  async transition(
    runId: string,
    status: RunRecord['status'],
    eventType: string,
    payload: Record<string, unknown> = {},
    lease?: RunLease,
  ): Promise<RunRecord> {
    const current = this.#runs.get(runId)
    if (!current) throw new AppError(404, 'run_not_found', 'The private run does not exist.')
    if (lease) this.#assertLease(runId, lease)
    if (current.status === status) return structuredClone(current)
    assertRunTransition(current.status, status)
    const updated = { ...current, status }
    this.#runs.set(runId, updated)
    if (['completed', 'failed', 'cancelled', 'timed_out', 'incomplete', 'deleted'].includes(status)) {
      this.#leases.delete(runId)
    }
    this.#recordEvent(runId, eventType, { ...payload, status })
    return structuredClone(updated)
  }

  async listEvents(runId: string, afterId: string): Promise<RunEvent[]> {
    const after = BigInt(afterId || '0')
    return (this.#events.get(runId) ?? []).filter((event) => BigInt(event.id) > after).map((event) => structuredClone(event))
  }

  async appendEvent(runId: string, eventType: string, payload: Record<string, unknown>, lease?: RunLease): Promise<void> {
    if (lease) this.#assertLease(runId, lease)
    this.#recordEvent(runId, eventType, payload)
  }

  async claimNext(workerId: string, leaseSeconds: number): Promise<RunRecord | null> {
    const now = Date.now()
    const run = [...this.#runs.values()].find((item) => {
      if (new Date(item.expiresAt).getTime() <= now) return false
      const lease = this.#leases.get(item.id)
      return item.status === 'queued'
        || (['provisioning', 'running', 'scoring'].includes(item.status) && (!lease || lease.expiresAt <= now))
    })
    if (!run) return null
    const version = run.leaseVersion + 1
    const updated = { ...run, status: 'provisioning' as const, leaseVersion: version }
    this.#runs.set(run.id, updated)
    this.#leases.set(run.id, { workerId, version, expiresAt: now + leaseSeconds * 1000 })
    this.#recordEvent(run.id, 'provisioning', { status: 'provisioning' })
    return structuredClone(updated)
  }

  async renewLease(runId: string, expected: RunLease, leaseSeconds: number): Promise<boolean> {
    const lease = this.#leases.get(runId)
    const now = Date.now()
    if (!lease || lease.workerId !== expected.workerId || lease.version !== expected.version || lease.expiresAt <= now) return false
    lease.expiresAt = now + leaseSeconds * 1000
    return true
  }

  async reserveAttempt(runId: string, jobId: string, maximumAttempts: number, lease: RunLease): Promise<boolean> {
    this.#assertLease(runId, lease)
    const attempts = this.#attempts.get(runId) ?? new Map<string, number>()
    const current = attempts.get(jobId) ?? 0
    if (current >= maximumAttempts) return false
    attempts.set(jobId, current + 1)
    this.#attempts.set(runId, attempts)
    return true
  }

  async saveObservations(runId: string, observations: StoredObservation[], lease?: RunLease): Promise<void> {
    if (lease) this.#assertLease(runId, lease)
    this.#recordObservations(runId, observations)
  }

  async listObservations(runId: string): Promise<StoredObservation[]> {
    return structuredClone(this.#observations.get(runId) ?? [])
  }

  async finalize(
    runId: string,
    status: 'completed' | 'incomplete' | 'failed',
    observations: StoredObservation[],
    report: RunReport,
    lease: RunLease,
  ): Promise<RunRecord> {
    const current = this.#runs.get(runId)
    if (!current) throw new AppError(404, 'run_not_found', 'The private run does not exist.')
    this.#assertLease(runId, lease)
    assertRunTransition(current.status, status)
    if (this.#reports.has(report.runId)) throw new AppError(409, 'report_exists', 'The run report is immutable.')
    this.#recordObservations(runId, observations)
    this.#reports.set(report.runId, structuredClone(report))
    const updated = { ...current, status }
    this.#runs.set(runId, updated)
    this.#leases.delete(runId)
    this.#recordEvent(runId, 'finished', { status })
    return structuredClone(updated)
  }

  async saveReport(report: RunReport): Promise<void> {
    if (this.#reports.has(report.runId)) throw new AppError(409, 'report_exists', 'The run report is immutable.')
    this.#reports.set(report.runId, structuredClone(report))
  }

  async getReport(runId: string): Promise<RunReport | null> {
    const value = this.#reports.get(runId)
    return value ? structuredClone(value) : null
  }

  async purge(runId: string): Promise<void> {
    const run = this.#runs.get(runId)
    if (run) this.#idempotency.delete(run.idempotencyKey)
    this.#runs.delete(runId)
    this.#events.delete(runId)
    this.#reports.delete(runId)
    this.#leases.delete(runId)
    this.#observations.delete(runId)
    this.#attempts.delete(runId)
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const ids = [...this.#runs.values()].filter((run) => new Date(run.expiresAt).getTime() <= now.getTime()).map((run) => run.id)
    for (const id of ids) await this.purge(id)
    return ids.length
  }

  async close(): Promise<void> {
    this.#runs.clear()
    this.#idempotency.clear()
    this.#events.clear()
    this.#reports.clear()
    this.#leases.clear()
    this.#observations.clear()
    this.#attempts.clear()
  }
}
