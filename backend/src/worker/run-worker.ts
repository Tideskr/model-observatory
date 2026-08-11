import { randomUUID } from 'node:crypto'
import type { AppServices } from '../services.js'
import { buildRunJobs, type ProbeJob } from '../executor/job-plan.js'
import { sendNormalRequest, TransportError, type TransportResult } from '../executor/normal-transport.js'
import { scoreObservation, scoreStoredRun, type RawObservation } from '../scoring/score.js'
import type { ScoringReleaseSeed } from '../scoring/types.js'
import { LeaseLostError, type RunLease, type RunRecord, type RunReport, type StoredObservation } from '../store/run-store.js'

type Transport = (input: {
  baseUrl: string; apiKey: string; model: string; messages: ProbeJob['messages']; effort: string; cacheKey: string;
  signal?: AbortSignal
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
    let cleanupCredential = false
    let renewing = false
    const lease: RunLease = { workerId: this.#workerId, version: run.leaseVersion }
    const controller = new AbortController()
    const renew = async () => {
      if (renewing || controller.signal.aborted) return
      renewing = true
      try {
        if (!await this.#services.runStore.renewLease(run.id, lease, this.#leaseSeconds)) controller.abort(new LeaseLostError())
      } catch (error) {
        controller.abort(error)
      } finally {
        renewing = false
      }
    }
    const heartbeat = setInterval(() => void renew(), Math.max(1_000, this.#leaseSeconds * 250))
    heartbeat.unref()
    try {
      const seed = await this.#loadScoring(run.scoringReleaseId)
      apiKey = await this.#services.credentialVault.read(run.credentialHandle)
      const jobs = buildRunJobs(run, seed)
      await this.#ensureLease(run.id, lease, controller)
      await this.#services.runStore.transition(run.id, 'running', 'started', { total_requests: jobs.length }, lease)
      const rows = await this.#executeJobs(run, jobs, apiKey, seed, lease, controller)
      await this.#ensureLease(run.id, lease, controller)
      await this.#services.runStore.transition(run.id, 'scoring', 'scoring', { completed_requests: rows.length }, lease)
      const scored = scoreStoredRun(run, rows, seed)
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
      await this.#services.runStore.finalize(run.id, scored.status, scored.storedObservations, report, lease)
      cleanupCredential = true
    } catch (error) {
      if (error instanceof LeaseLostError || controller.signal.reason instanceof LeaseLostError) return
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
          try {
            await this.#services.runStore.finalize(run.id, 'failed', [], report, lease)
            cleanupCredential = true
          } catch (finalizeError) {
            if (!(finalizeError instanceof LeaseLostError)) throw finalizeError
          }
        }
      }
    } finally {
      clearInterval(heartbeat)
      apiKey = ''
      if (cleanupCredential) await this.#services.credentialVault.delete(run.credentialHandle)
    }
  }

  async #ensureLease(runId: string, lease: RunLease, controller: AbortController): Promise<void> {
    if (controller.signal.aborted || !await this.#services.runStore.renewLease(runId, lease, this.#leaseSeconds)) {
      controller.abort(new LeaseLostError())
      throw new LeaseLostError()
    }
  }

  async #executeJobs(
    run: RunRecord,
    jobs: ProbeJob[],
    apiKey: string,
    seed: ScoringReleaseSeed,
    lease: RunLease,
    controller: AbortController,
  ): Promise<StoredObservation[]> {
    const plannedJobIds = new Set(jobs.map((job) => job.jobId))
    const existing = (await this.#services.runStore.listObservations(run.id))
      .filter((item) => plannedJobIds.has(item.jobId))
    const completedJobs = new Set(existing.map((item) => item.jobId))
    let cursor = 0
    let completed = completedJobs.size
    const execute = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        const job = jobs[index]
        if (!job) return
        if (completedJobs.has(job.jobId)) continue
        const raw = await this.#executeJob(run, job, apiKey, lease, controller)
        const observation = scoreObservation(run, raw, seed)
        await this.#services.runStore.saveObservations(run.id, [observation], lease)
        completedJobs.add(job.jobId)
        completed += 1
        await this.#services.runStore.appendEvent(run.id, 'progress', { completed, total: jobs.length }, lease)
      }
    }
    await Promise.all(Array.from({ length: Math.min(run.config.workers, jobs.length) }, execute))
    const observations = await this.#services.runStore.listObservations(run.id)
    const byJob = new Map(observations.map((item) => [item.jobId, item]))
    return jobs.map((job) => byJob.get(job.jobId)).filter((item): item is StoredObservation => item != null)
  }

  async #executeJob(
    run: RunRecord,
    job: ProbeJob,
    apiKey: string,
    lease: RunLease,
    controller: AbortController,
  ): Promise<RawObservation> {
    for (let attempt = 0; attempt <= run.config.retries; attempt += 1) {
      await this.#ensureLease(run.id, lease, controller)
      const reserved = await this.#services.runStore.reserveAttempt(run.id, job.jobId, run.config.retries + 1, lease)
      if (!reserved) return { job, status: 'error', safeError: 'attempt_budget_exhausted' }
      try {
        const result = await this.#transport({
          baseUrl: run.targetBaseUrl,
          apiKey,
          model: run.model,
          messages: job.messages,
          effort: job.effort,
          cacheKey: job.cacheKey,
          signal: controller.signal,
        })
        return { job, status: 'ok', answer: result.answer, elapsedMs: result.elapsedMs }
      } catch (error) {
        if (controller.signal.aborted) throw new LeaseLostError()
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
