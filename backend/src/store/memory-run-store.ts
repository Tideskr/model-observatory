import { assertRunTransition } from '../domain/run-state.js'
import { AppError } from '../errors.js'
import type { RunEvent, RunRecord, RunReport, RunStore, StoredObservation } from './run-store.js'

export class MemoryRunStore implements RunStore {
  readonly #runs = new Map<string, RunRecord>()
  readonly #idempotency = new Map<string, string>()
  readonly #events = new Map<string, RunEvent[]>()
  readonly #reports = new Map<string, RunReport>()
  readonly #leases = new Map<string, { workerId: string; expiresAt: number }>()
  readonly #observations = new Map<string, StoredObservation[]>()
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
    await this.appendEvent(record.id, 'status', { status: record.status })
    return { record: structuredClone(record), created: true }
  }

  async get(runId: string): Promise<RunRecord | null> {
    const value = this.#runs.get(runId)
    return value ? structuredClone(value) : null
  }

  async transition(runId: string, status: RunRecord['status'], eventType: string, payload: Record<string, unknown> = {}): Promise<RunRecord> {
    const current = this.#runs.get(runId)
    if (!current) throw new AppError(404, 'run_not_found', 'The private run does not exist.')
    if (current.status === status) return structuredClone(current)
    assertRunTransition(current.status, status)
    const updated = { ...current, status }
    this.#runs.set(runId, updated)
    await this.appendEvent(runId, eventType, { ...payload, status })
    return structuredClone(updated)
  }

  async listEvents(runId: string, afterId: string): Promise<RunEvent[]> {
    const after = BigInt(afterId || '0')
    return (this.#events.get(runId) ?? []).filter((event) => BigInt(event.id) > after).map((event) => structuredClone(event))
  }

  async appendEvent(runId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    this.#eventId += 1n
    const events = this.#events.get(runId) ?? []
    events.push({ id: String(this.#eventId), runId, eventType, payload, createdAt: new Date().toISOString() })
    this.#events.set(runId, events)
  }

  async claimNext(workerId: string, leaseSeconds: number): Promise<RunRecord | null> {
    const now = Date.now()
    const run = [...this.#runs.values()].find((item) => {
      const lease = this.#leases.get(item.id)
      return item.status === 'queued' || (item.status === 'provisioning' && (!lease || lease.expiresAt <= now))
    })
    if (!run) return null
    const updated = { ...run, status: 'provisioning' as const }
    this.#runs.set(run.id, updated)
    this.#leases.set(run.id, { workerId, expiresAt: now + leaseSeconds * 1000 })
    await this.appendEvent(run.id, 'provisioning', { status: 'provisioning' })
    return structuredClone(updated)
  }

  async renewLease(runId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const lease = this.#leases.get(runId)
    if (!lease || lease.workerId !== workerId) return false
    lease.expiresAt = Date.now() + leaseSeconds * 1000
    return true
  }

  async saveObservations(runId: string, observations: StoredObservation[]): Promise<void> {
    const existing = this.#observations.get(runId) ?? []
    const known = new Set(existing.map((item) => item.jobId))
    existing.push(...observations.filter((item) => !known.has(item.jobId)).map((item) => structuredClone(item)))
    this.#observations.set(runId, existing)
  }

  async finalize(
    runId: string,
    status: 'completed' | 'incomplete' | 'failed',
    observations: StoredObservation[],
    report: RunReport,
  ): Promise<RunRecord> {
    const current = this.#runs.get(runId)
    if (!current) throw new AppError(404, 'run_not_found', 'The private run does not exist.')
    assertRunTransition(current.status, status)
    await this.saveObservations(runId, observations)
    await this.saveReport(report)
    const updated = { ...current, status }
    this.#runs.set(runId, updated)
    await this.appendEvent(runId, 'finished', { status })
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
  }
}
