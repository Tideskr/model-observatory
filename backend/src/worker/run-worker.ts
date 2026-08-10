import { randomUUID } from 'node:crypto'
import type { AppServices } from '../services.js'
import { buildRunJobs, type ProbeJob } from '../executor/job-plan.js'
import { sendNormalRequest, TransportError, type TransportResult } from '../executor/normal-transport.js'
import { scoreRun, type RawObservation } from '../scoring/score.js'
import type { ScoringReleaseSeed } from '../scoring/types.js'
import type { RunRecord, RunReport } from '../store/run-store.js'

type Transport = (input: {
  baseUrl: string; apiKey: string; model: string; messages: ProbeJob['messages']; effort: string; cacheKey: string
}) => Promise<TransportResult>

export interface RunWorkerOptions {
  services: AppServices
  loadScoringRelease: (releaseId: string) => Promise<ScoringReleaseSeed>
  transport?: Transport
  workerId?: string
  leaseSeconds?: number
}

export class RunWorker {
  readonly #services: AppServices
  readonly #loadScoring: RunWorkerOptions['loadScoringRelease']
  readonly #transport: Transport
  readonly #workerId: string
  readonly #leaseSeconds: number

  constructor(options: RunWorkerOptions) {
    this.#services = options.services
    this.#loadScoring = options.loadScoringRelease
    this.#transport = options.transport ?? sendNormalRequest
    this.#workerId = options.workerId ?? `worker-${randomUUID()}`
    this.#leaseSeconds = options.leaseSeconds ?? 60
  }

  async runOnce(): Promise<boolean> {
    const run = await this.#services.runStore.claimNext(this.#workerId, this.#leaseSeconds)
    if (!run) return false
    await this.#execute(run)
    return true
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.runOnce()
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  async #execute(run: RunRecord): Promise<void> {
    let apiKey = ''
    const heartbeat = setInterval(() => {
      void this.#services.runStore.renewLease(run.id, this.#workerId, this.#leaseSeconds)
    }, Math.max(5_000, this.#leaseSeconds * 500))
    heartbeat.unref()
    try {
      const seed = await this.#loadScoring(run.scoringReleaseId)
      apiKey = await this.#services.credentialVault.read(run.credentialHandle)
      const jobs = buildRunJobs(run, seed)
      await this.#services.runStore.transition(run.id, 'running', 'started', { total_requests: jobs.length })
      const rows = await this.#executeJobs(run, jobs, apiKey)
      const latest = await this.#services.runStore.get(run.id)
      if (!latest || latest.status === 'cancelled' || latest.status === 'deleted') return
      await this.#services.runStore.transition(run.id, 'scoring', 'scoring', { completed_requests: rows.length })
      const scored = scoreRun(run, rows, seed)
      const report: RunReport = {
        runId: run.id,
        status: scored.status,
        terminal: true,
        scoringReleaseId: run.scoringReleaseId,
        target: { origin: run.targetOrigin, model: run.model },
        summary: scored.summary,
        observations: scored.observations,
        createdAt: new Date().toISOString(),
      }
      await this.#services.runStore.finalize(run.id, scored.status, scored.storedObservations, report)
    } catch (error) {
      const latest = await this.#services.runStore.get(run.id)
      if (latest && !['cancelled', 'deleted', 'completed', 'failed', 'incomplete'].includes(latest.status)) {
        const safeError = error instanceof TransportError ? error.category : 'worker_execution_failed'
        const report: RunReport = {
          runId: run.id,
          status: 'failed',
          terminal: true,
          scoringReleaseId: run.scoringReleaseId,
          target: { origin: run.targetOrigin, model: run.model },
          summary: { operational_status: 'failed', safe_error: safeError },
          observations: [],
          createdAt: new Date().toISOString(),
        }
        if (latest.status === 'provisioning' || latest.status === 'running' || latest.status === 'scoring') {
          await this.#services.runStore.finalize(run.id, 'failed', [], report)
        }
      }
    } finally {
      clearInterval(heartbeat)
      apiKey = ''
      await this.#services.credentialVault.delete(run.credentialHandle)
    }
  }

  async #executeJobs(run: RunRecord, jobs: ProbeJob[], apiKey: string): Promise<RawObservation[]> {
    const results: (RawObservation | undefined)[] = Array.from({ length: jobs.length })
    let cursor = 0
    let completed = 0
    const execute = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        const job = jobs[index]
        if (!job) return
        const latest = await this.#services.runStore.get(run.id)
        if (!latest || latest.status === 'cancelled' || latest.status === 'deleted') {
          results[index] = { job, status: 'cancelled' }
          continue
        }
        results[index] = await this.#executeJob(run, job, apiKey)
        completed += 1
        await this.#services.runStore.appendEvent(run.id, 'progress', { completed, total: jobs.length })
      }
    }
    await Promise.all(Array.from({ length: Math.min(run.config.workers, jobs.length) }, execute))
    return results.filter((item): item is RawObservation => item != null)
  }

  async #executeJob(run: RunRecord, job: ProbeJob, apiKey: string): Promise<RawObservation> {
    for (let attempt = 0; attempt <= run.config.retries; attempt += 1) {
      try {
        const result = await this.#transport({
          baseUrl: run.targetBaseUrl,
          apiKey,
          model: run.model,
          messages: job.messages,
          effort: job.effort,
          cacheKey: job.cacheKey,
        })
        return { job, status: 'ok', answer: result.answer, elapsedMs: result.elapsedMs }
      } catch (error) {
        const transport = error instanceof TransportError ? error : new TransportError('connection_or_tls_error', true)
        if (!transport.retryable || attempt === run.config.retries) {
          return { job, status: 'error', safeError: transport.category }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * 2 ** attempt)))
      }
    }
    return { job, status: 'error', safeError: 'retry_exhausted' }
  }
}
