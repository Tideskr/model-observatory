import { createHash, randomUUID } from 'node:crypto'
import type { AppConfig } from '../config.js'
import { DONATION_MEDIUM_CONFIG, donationModelEstimate } from '../domain/donation-plan.js'
import { probeProviderIdentity, type ProviderProbeResult } from '../executor/provider-probe.js'
import type { AppServices } from '../services.js'
import type { DonationError } from '../contracts/contributions.js'
import type { RegistryProvider } from '../registry/catalog.js'
import type { RunRecord, RunReport } from '../store/run-store.js'
import type { DonationRunAnomaly, DonationTestRunRecord } from '../store/contribution-store.js'

type IdentityProbe = (input: { baseUrl: string; apiKey: string; provider: RegistryProvider; selectedGroupId: string }) => Promise<ProviderProbeResult>

export interface DonationSchedulerOptions {
  config: AppConfig
  services: AppServices
  workerId?: string
  leaseSeconds?: number
  identityProbe?: IdentityProbe
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function reportErrors(report: RunReport): DonationError[] {
  const raw = Array.isArray(report.summary['error_summary']) ? report.summary['error_summary'] : []
  return raw.slice(0, 20).flatMap((item): DonationError[] => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    return [{
      stage: 'model_test', code: String(value['code'] ?? 'upstream_error'),
      message: String(value['message'] ?? 'The upstream request failed.').slice(0, 800),
      model: report.target.model, http_status: typeof value['http_status'] === 'number' ? value['http_status'] : null,
      retryable: value['retryable'] === true, at: report.createdAt,
    }]
  })
}

function runOutcome(report: RunReport): NonNullable<DonationTestRunRecord['outcome']> {
  const successful = number(report.summary['successful_requests'])
  if (successful === 0 || report.status === 'failed') return 'unavailable'
  const hard = report.observations.some((item) => item['hard_anomaly'] === true)
  const verdict = String(report.summary['overall_verdict'] ?? '')
  if (hard || verdict.startsWith('Juice与') || verdict.startsWith('可能非GPT')) return 'fail'
  if (verdict.startsWith('Juice通过')) return 'pass'
  return 'inconclusive'
}

function anomalies(report: RunReport): DonationRunAnomaly[] {
  return report.observations.filter((item) => item['hard_anomaly'] === true).slice(0, 50).map((item) => ({
    id: createHash('sha256').update(`${report.runId}:${String(item['job_id'])}`).digest('hex'),
    probeId: String(item['probe_id'] ?? 'unknown'), expected: `符合 ${report.target.model} 的校准结果`,
    observed: String(item['normalized_value'] ?? item['classification'] ?? '无可用输出').slice(0, 500), severity: 'hard' as const,
  }))
}

function actualCost(report: RunReport, inputPrice: number, outputPrice: number, multiplier: number, fallback: number): number {
  let input = 0
  let output = 0
  let missingUsage = 0
  for (const item of report.observations) {
    const metadata = item['metadata']
    if (!metadata || typeof metadata !== 'object') { missingUsage += 1; continue }
    const values = metadata as Record<string, unknown>
    const hasInput = typeof values['input_tokens'] === 'number'
    const hasOutput = typeof values['output_tokens'] === 'number'
    if (hasInput) input += values['input_tokens'] as number
    if (hasOutput) output += values['output_tokens'] as number
    if (!hasInput && !hasOutput) missingUsage += 1
  }
  const measured = ((input / 1_000_000) * inputPrice + (output / 1_000_000) * outputPrice) * multiplier
  const fallbackShare = report.observations.length ? fallback * (missingUsage / report.observations.length) : fallback
  return Number(Math.min(fallback, measured + fallbackShare).toFixed(6))
}

export class DonationScheduler {
  readonly #config: AppConfig
  readonly #services: AppServices
  readonly #workerId: string
  readonly #leaseSeconds: number
  readonly #identityProbe: IdentityProbe

  constructor(options: DonationSchedulerOptions) {
    this.#config = options.config
    this.#services = options.services
    this.#workerId = options.workerId ?? `donation-${randomUUID()}`
    this.#leaseSeconds = options.leaseSeconds ?? 60
    this.#identityProbe = options.identityProbe ?? probeProviderIdentity
  }

  async scheduleOnce(): Promise<boolean> {
    const donation = await this.#services.contributionStore.claimDueDonation(this.#workerId, this.#leaseSeconds)
    if (!donation) return false
    const provider = this.#services.providerRegistry.document.providers.find((item) => item.slug === donation.providerSlug)
    const group = provider?.groups.find((item) => item.id === donation.groupId)
    if (!provider || !group) {
      await this.#services.contributionStore.updateDonationFromWorker(donation.id, this.#workerId, {
        phase: 'registry_mismatch', nextRunAt: null,
        errors: [{ stage: 'registry', code: 'provider_registry_drift', message: 'The configured provider group is unavailable.', model: null, http_status: null, retryable: false, at: new Date().toISOString() }],
      }, true)
      return true
    }
    let apiKey = ''
    const createdRuns: RunRecord[] = []
    try {
      apiKey = await this.#services.credentialVault.read(donation.credentialHandle)
      let attribution = donation.groupAttribution === 'pending' ? 'donor_declared' as const : donation.groupAttribution
      let detectedGroupId = donation.detectedGroupId
      let probeErrors: DonationError[] = []
      if (donation.status === 'quarantined') {
        const probe = await this.#identityProbe({ baseUrl: donation.targetBaseUrl, apiKey, provider, selectedGroupId: group.id })
        detectedGroupId = probe.detectedGroupId
        attribution = probe.attribution
        probeErrors = probe.errors
        const blocking = probe.errors.find((item) => item.code === 'credential_rejected' || item.code === 'provider_probe_connection_failed')
        if (blocking) {
          await this.#services.contributionStore.updateDonationFromWorker(donation.id, this.#workerId, {
            detectedGroupId, groupAttribution: attribution, phase: 'identity_probe_failed', errors: probeErrors,
            nextRunAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          }, true)
          return true
        }
        if (detectedGroupId && detectedGroupId !== group.id) {
          await this.#services.contributionStore.updateDonationFromWorker(donation.id, this.#workerId, {
            detectedGroupId, groupAttribution: 'verified', phase: 'group_mismatch',
            errors: [{ stage: 'identity_probe', code: 'group_mismatch', message: `Detected group ${detectedGroupId}, but the donation selected ${group.id}.`, model: null, http_status: null, retryable: false, at: new Date().toISOString() }],
            nextRunAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          }, true)
          return true
        }
      }
      const pricing = this.#services.providerRegistry.document.pricing
      const estimate = donationModelEstimate({ input_per_million: pricing.input_per_million_usd, output_per_million: pricing.output_per_million_usd, multiplier: group.multiplier })
      const reserve = Number((estimate.maximum_cost_usd * group.models.length).toFixed(6))
      const remaining = donation.constraints.quota_usd - donation.quotaSpentUsd
      if (remaining < reserve) {
        await this.#services.contributionStore.updateDonationFromWorker(donation.id, this.#workerId, {
          detectedGroupId, groupAttribution: attribution, phase: 'quota_exhausted', nextRunAt: null, quotaReservedUsd: 0,
          errors: [{ stage: 'quota', code: 'quota_exhausted', message: `Remaining quota $${remaining.toFixed(6)} cannot reserve the next cycle maximum $${reserve.toFixed(6)}.`, model: null, http_status: null, retryable: false, at: new Date().toISOString() }],
        }, true)
        return true
      }
      const cycleId = randomUUID()
      const expiresAt = new Date(Date.now() + this.#config.runRetentionHours * 60 * 60 * 1000)
      const runLinks: DonationTestRunRecord[] = []
      for (const model of group.models) {
        const runId = randomUUID()
        const credentialHandle = await this.#services.credentialVault.put(apiKey, `donation-cycle:${cycleId}:${model}`, expiresAt)
        const run: RunRecord = {
          id: runId, quoteId: randomUUID(), requestDigest: createHash('sha256').update(`${cycleId}:${model}`).digest('hex'),
          status: 'queued', evidenceSource: 'donated', targetOrigin: donation.targetOrigin, targetBaseUrl: donation.targetBaseUrl,
          targetHostname: donation.targetHostname, model,
          config: { ...DONATION_MEDIUM_CONFIG, probes: DONATION_MEDIUM_CONFIG.probes.map((item) => ({ ...item })), workers: Math.min(donation.constraints.concurrency, DONATION_MEDIUM_CONFIG.workers) },
          disclosureVersion: 'remote-normal-v1', scoringReleaseId: this.#config.scoringReleaseId,
          ownerTokenHash: createHash('sha256').update(`donation:${cycleId}:${model}`).digest('hex'),
          idempotencyKey: `donation:${cycleId}:${model}`, credentialHandle, createdAt: new Date().toISOString(),
          expiresAt: expiresAt.toISOString(), leaseVersion: 0,
        }
        createdRuns.push(run)
        await this.#services.runStore.create(run)
        runLinks.push({ cycleId, donationId: donation.id, privateRunId: runId, providerSlug: provider.slug,
          groupId: group.id, model, attribution, outcome: null, successfulRequests: null, attemptedRequests: null,
          estimatedCostUsd: null, completedAt: null })
      }
      await this.#services.contributionStore.updateDonationFromWorker(donation.id, this.#workerId, {
        detectedGroupId, groupAttribution: attribution, errors: probeErrors,
      })
      await this.#services.contributionStore.createDonationCycle({
        id: cycleId, donationId: donation.id, status: 'running', attribution, reservedCostUsd: reserve,
        actualCostUsd: 0, createdAt: new Date().toISOString(), completedAt: null,
      }, runLinks, this.#workerId)
      createdRuns.length = 0
      return true
    } catch (error) {
      for (const run of createdRuns) {
        const current = await this.#services.runStore.get(run.id)
        if (current && !['completed', 'failed', 'cancelled', 'timed_out', 'incomplete', 'deleted'].includes(current.status)) {
          await this.#services.runStore.transition(run.id, 'cancelled', 'cancelled', { reason: 'donation_schedule_failed' }).catch(() => undefined)
        }
        await this.#services.credentialVault.delete(run.credentialHandle).catch(() => undefined)
      }
      await this.#services.contributionStore.updateDonationFromWorker(donation.id, this.#workerId, {
        phase: 'scheduler_failed', nextRunAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        errors: [{ stage: 'scheduler', code: 'scheduler_failed', message: error instanceof Error ? error.message.slice(0, 800) : 'Unknown scheduler failure.', model: null, http_status: null, retryable: true, at: new Date().toISOString() }],
      }, true).catch(() => undefined)
      return true
    } finally { apiKey = '' }
  }

  async reconcileOnce(): Promise<boolean> {
    let worked = false
    const pending = await this.#services.contributionStore.listPendingDonationRuns()
    for (const link of pending) {
      const report = await this.#services.runStore.getReport(link.privateRunId)
      if (!report?.terminal) continue
      const provider = this.#services.providerRegistry.document.providers.find((item) => item.slug === link.providerSlug)
      const group = provider?.groups.find((item) => item.id === link.groupId)
      if (!group) continue
      const pricing = this.#services.providerRegistry.document.pricing
      const fallback = donationModelEstimate({ input_per_million: pricing.input_per_million_usd, output_per_million: pricing.output_per_million_usd, multiplier: group.multiplier }).maximum_cost_usd
      await this.#services.contributionStore.completeDonationRun(link.privateRunId, {
        outcome: runOutcome(report), successfulRequests: number(report.summary['successful_requests']),
        attemptedRequests: number(report.summary['completed_requests']),
        estimatedCostUsd: actualCost(report, pricing.input_per_million_usd, pricing.output_per_million_usd, group.multiplier, fallback),
        anomalies: anomalies(report),
      })
      worked = true
    }
    const ready = await this.#services.contributionStore.listReadyDonationCycles()
    for (const cycle of ready) {
      const runs = await this.#services.contributionStore.listDonationCycleRuns(cycle.id)
      const errors: DonationError[] = []
      for (const run of runs) {
        const report = await this.#services.runStore.getReport(run.privateRunId)
        if (report) errors.push(...reportErrors(report))
      }
      const spent = Number(runs.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0).toFixed(6))
      const donation = await this.#services.contributionStore.getDonation(cycle.donationId)
      const interval = donation?.constraints.interval_minutes ?? 240
      const jitter = 0.85 + Math.random() * 0.3
      await this.#services.contributionStore.finalizeDonationCycle(cycle.id, spent, errors.slice(0, 50), new Date(Date.now() + interval * jitter * 60_000).toISOString())
      worked = true
    }
    return worked
  }
}
