import { randomUUID } from 'node:crypto'
import type { AppServices } from '../services.js'
import { buildRunJobs, type ProbeJob } from '../executor/job-plan.js'
import { sendNormalRequest, TransportError, type TransportResult } from '../executor/normal-transport.js'
import { AppError } from '../errors.js'
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
      await this.#services.runStore.transition(run.id, 'running', 'started', {
        phase: 'executing', completed: 0, total: jobs.length, successful: 0, errors: 0,
        cancelled: 0, pending: jobs.length, in_flight: 0, http_attempts: 0, retries: 0,
      }, lease)
      const rows = await this.#executeJobs(run, jobs, apiKey, seed, lease, controller)
      await this.#ensureLease(run.id, lease, controller)
      const failedRows = rows.filter((item) => item.status === 'error').length
      const attempts = rows.reduce((sum, item) => sum + Number(item.metadata['attempts_sent'] ?? 1), 0)
      await this.#services.runStore.transition(run.id, 'scoring', 'scoring', {
        phase: 'scoring', completed: rows.length, total: jobs.length,
        successful: rows.length - failedRows, errors: failedRows, cancelled: 0,
        pending: 0, in_flight: 0, http_attempts: attempts, retries: Math.max(0, attempts - rows.length),
      }, lease)
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
        const failure = error instanceof TransportError
          ? { stage: 'transport', code: error.category, status_code: error.statusCode, retryable: error.retryable, message: error.message }
          : error instanceof AppError
            ? { stage: 'validation', code: error.code, status_code: error.statusCode, retryable: false, message: error.message }
            : { stage: 'worker', code: 'worker_execution_failed', status_code: null, retryable: false, message: error instanceof Error ? error.message : 'Unknown worker error' }
        const report: RunReport = {
          runId: run.id,
          status: 'failed',
          terminal: true,
          scoringReleaseId: run.scoringReleaseId,
          target: { origin: run.targetOrigin, model: run.model },
          summary: {
            overall_verdict: '检测失败',
            title_cn: '检测失败',
            subtitle_cn: failure.message,
            verdict_available: false,
            operational_status: 'failed',
            safe_error: failure.code,
            error_detail: failure,
            completed_requests: 0,
            failed_requests: 0,
          },
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
    let successful = existing.filter((item) => item.status === 'ok').length
    let errors = existing.filter((item) => item.status === 'error').length
    let inFlight = 0
    let httpAttempts = existing.reduce((sum, item) => sum + Number(item.metadata['attempts_sent'] ?? 1), 0)
    let retries = Math.max(0, httpAttempts - existing.length)
    const progress = () => ({
      status: 'running', phase: 'executing', completed, total: jobs.length, successful, errors,
      cancelled: 0, pending: Math.max(0, jobs.length - completed - inFlight), in_flight: inFlight,
      http_attempts: httpAttempts, retries,
    })
    const execute = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        const job = jobs[index]
        if (!job) return
        if (completedJobs.has(job.jobId)) continue
        inFlight += 1
        await this.#services.runStore.appendEvent(run.id, 'progress', progress(), lease)
        const raw = await this.#executeJob(run, job, apiKey, lease, controller)
        const observation = scoreObservation(run, raw, seed)
        await this.#services.runStore.saveObservations(run.id, [observation], lease)
        completedJobs.add(job.jobId)
        completed += 1
        inFlight -= 1
        if (observation.status === 'ok') successful += 1
        else if (observation.status === 'error') errors += 1
        const attempts = Number(observation.metadata['attempts_sent'] ?? 1)
        httpAttempts += attempts
        retries += Math.max(0, attempts - 1)
        await this.#services.runStore.appendEvent(run.id, 'progress', progress(), lease)
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
      if (!reserved) return { job, status: 'error', safeError: 'attempt_budget_exhausted', safeMessage: 'This job exhausted its durable attempt budget.', attempts: attempt, retryable: false }
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
        return {
          job, status: 'ok', answer: result.answer, elapsedMs: result.elapsedMs, attempts: attempt + 1,
          statusCode: result.statusCode,
          ...(result.inputTokens == null ? {} : { inputTokens: result.inputTokens }),
          ...(result.outputTokens == null ? {} : { outputTokens: result.outputTokens }),
        }
      } catch (error) {
        if (controller.signal.aborted) throw new LeaseLostError()
        if (error instanceof AppError) {
          return { job, status: 'error', safeError: error.code, safeMessage: error.message, attempts: attempt + 1, statusCode: error.statusCode, retryable: false }
        }
        const transport = error instanceof TransportError ? error : new TransportError('connection_or_tls_error', true)
        if (!transport.retryable || attempt === run.config.retries) {
          return {
            job, status: 'error', safeError: transport.category, safeMessage: transport.message,
            attempts: attempt + 1, statusCode: transport.statusCode, retryable: transport.retryable,
          }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * 2 ** attempt)))
      }
    }
    return { job, status: 'error', safeError: 'retry_exhausted', safeMessage: 'All configured retries were exhausted.', attempts: run.config.retries + 1, retryable: false }
  }
}
