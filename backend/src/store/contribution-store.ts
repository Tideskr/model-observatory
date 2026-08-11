import type { DonationConstraints, DonationError, DonationStatus, RegistryProposalField } from '../contracts/contributions.js'
import { AppError } from '../errors.js'

export interface DonationRecord {
  id: string
  quoteId: string
  requestDigest: string
  idempotencyKey: string
  kind: 'api'
  status: DonationStatus
  targetOrigin: string
  targetBaseUrl: string
  targetHostname: string
  providerSlug: string
  groupId: string
  detectedGroupId: string | null
  groupAttribution: 'pending' | 'verified' | 'donor_declared'
  phase: string
  progressCurrent: number
  progressTotal: number
  currentModel: string | null
  nextRunAt: string | null
  lastCheckedAt: string | null
  quotaSpentUsd: number
  quotaReservedUsd: number
  errors: DonationError[]
  constraints: DonationConstraints
  credentialHandle: string
  credentialFingerprintTail: string
  revocationTokenHash: string
  disclosureVersion: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
}

export interface RegistryProposalRecord {
  id: string
  probeId: string
  field: RegistryProposalField
  currentValue: string
  proposedValue: string
  reason: string
  evidenceUrls: string[]
  contentSha256: string
  status: 'gitops_pending'
  issueUrl: string
  createdAt: string
}

export interface DonationCycleRecord {
  id: string
  donationId: string
  status: 'scheduled' | 'running' | 'completed' | 'blocked'
  attribution: 'verified' | 'donor_declared'
  reservedCostUsd: number
  actualCostUsd: number
  createdAt: string
  completedAt: string | null
}

export interface DonationTestRunRecord {
  cycleId: string
  donationId: string
  privateRunId: string
  providerSlug: string
  groupId: string
  model: string
  modelProbability: number | null
  attribution: 'verified' | 'donor_declared'
  outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable' | null
  successfulRequests: number | null
  attemptedRequests: number | null
  estimatedCostUsd: number | null
  completedAt: string | null
}

export interface DonationRunAnomaly {
  id: string
  probeId: string
  expected: string
  observed: string
  severity: 'hard' | 'soft'
}

export type DonationWorkerPatch = Partial<Pick<DonationRecord,
  'status' | 'detectedGroupId' | 'groupAttribution' | 'phase' | 'progressCurrent' | 'progressTotal' |
  'currentModel' | 'nextRunAt' | 'lastCheckedAt' | 'quotaSpentUsd' | 'quotaReservedUsd' | 'errors'>>

export interface ContributionStore {
  createDonation(record: DonationRecord): Promise<{ record: DonationRecord; created: boolean }>
  getDonation(id: string): Promise<DonationRecord | null>
  revokeDonation(id: string, revokedAt: string): Promise<DonationRecord>
  expireDonation(id: string): Promise<DonationRecord>
  claimDueDonation(workerId: string, leaseSeconds: number): Promise<DonationRecord | null>
  updateDonationFromWorker(id: string, workerId: string, patch: DonationWorkerPatch, releaseLease?: boolean): Promise<DonationRecord>
  createDonationCycle(cycle: DonationCycleRecord, runs: DonationTestRunRecord[], workerId: string): Promise<void>
  listPendingDonationRuns(): Promise<DonationTestRunRecord[]>
  completeDonationRun(runId: string, completion: {
    outcome: NonNullable<DonationTestRunRecord['outcome']>; successfulRequests: number; attemptedRequests: number;
    estimatedCostUsd: number; modelProbability: number | null; anomalies: DonationRunAnomaly[]
  }): Promise<void>
  listReadyDonationCycles(): Promise<DonationCycleRecord[]>
  listDonationCycleRuns(cycleId: string): Promise<DonationTestRunRecord[]>
  finalizeDonationCycle(cycleId: string, spentUsd: number, errors: DonationError[], nextRunAt: string): Promise<void>
  createProposal(record: RegistryProposalRecord): Promise<void>
  getProposal(id: string): Promise<RegistryProposalRecord | null>
  close(): Promise<void>
}

export class MemoryContributionStore implements ContributionStore {
  readonly #donations = new Map<string, DonationRecord>()
  readonly #donationIdempotency = new Map<string, string>()
  readonly #proposals = new Map<string, RegistryProposalRecord>()
  readonly #cycles = new Map<string, DonationCycleRecord>()
  readonly #testRuns = new Map<string, DonationTestRunRecord>()
  readonly #claims = new Map<string, { workerId: string; expiresAt: number }>()

  async createDonation(record: DonationRecord): Promise<{ record: DonationRecord; created: boolean }> {
    const existingId = this.#donationIdempotency.get(record.idempotencyKey)
    if (existingId) {
      const existing = this.#donations.get(existingId)
      if (!existing) throw new Error('donation idempotency index is corrupt')
      if (existing.requestDigest !== record.requestDigest) {
        throw new AppError(409, 'idempotency_conflict', 'The idempotency key was already used for a different request.')
      }
      return { record: structuredClone(existing), created: false }
    }
    if (this.#donations.has(record.id)) throw new AppError(409, 'donation_exists', 'The donation already exists.')
    this.#donations.set(record.id, structuredClone(record))
    this.#donationIdempotency.set(record.idempotencyKey, record.id)
    return { record: structuredClone(record), created: true }
  }

  async getDonation(id: string): Promise<DonationRecord | null> {
    const record = this.#donations.get(id)
    return record ? structuredClone(record) : null
  }

  async revokeDonation(id: string, revokedAt: string): Promise<DonationRecord> {
    const record = this.#donations.get(id)
    if (!record) throw new AppError(404, 'donation_not_found', 'The donation does not exist.')
    if (record.status !== 'revoked') {
      record.status = 'revoked'
      record.revokedAt = revokedAt
    }
    this.#claims.delete(id)
    return structuredClone(record)
  }

  async expireDonation(id: string): Promise<DonationRecord> {
    const record = this.#donations.get(id)
    if (!record) throw new AppError(404, 'donation_not_found', 'The donation does not exist.')
    if (record.status !== 'revoked') record.status = 'expired'
    this.#claims.delete(id)
    return structuredClone(record)
  }

  async claimDueDonation(workerId: string, leaseSeconds: number): Promise<DonationRecord | null> {
    const now = Date.now()
    for (const record of this.#donations.values()) {
      const claim = this.#claims.get(record.id)
      if (!['quarantined', 'active'].includes(record.status) || record.nextRunAt == null || new Date(record.nextRunAt).getTime() > now || (claim && claim.expiresAt > now)) continue
      this.#claims.set(record.id, { workerId, expiresAt: now + leaseSeconds * 1000 })
      return structuredClone(record)
    }
    return null
  }

  async updateDonationFromWorker(id: string, workerId: string, patch: DonationWorkerPatch, releaseLease = false): Promise<DonationRecord> {
    const record = this.#donations.get(id)
    const claim = this.#claims.get(id)
    if (!record || !claim || claim.workerId !== workerId) throw new AppError(409, 'donation_lease_lost', 'The donation worker lease was lost.')
    Object.assign(record, structuredClone(patch))
    if (releaseLease) this.#claims.delete(id)
    return structuredClone(record)
  }

  async createDonationCycle(cycle: DonationCycleRecord, runs: DonationTestRunRecord[], workerId: string): Promise<void> {
    const donation = this.#donations.get(cycle.donationId)
    const claim = this.#claims.get(cycle.donationId)
    if (!donation || !['quarantined', 'active'].includes(donation.status) || !claim || claim.workerId !== workerId) {
      throw new AppError(409, 'donation_lease_lost', 'The donation worker lease was lost.')
    }
    this.#cycles.set(cycle.id, structuredClone(cycle))
    for (const run of runs) this.#testRuns.set(run.privateRunId, structuredClone(run))
    donation.phase = 'testing'
    donation.progressCurrent = 0
    donation.quotaReservedUsd = cycle.reservedCostUsd
    donation.nextRunAt = null
    donation.currentModel = runs[0]?.model ?? null
    this.#claims.delete(cycle.donationId)
  }

  async listPendingDonationRuns(): Promise<DonationTestRunRecord[]> {
    return [...this.#testRuns.values()].filter((item) => !item.completedAt).map((item) => structuredClone(item))
  }

  async completeDonationRun(runId: string, completion: { outcome: NonNullable<DonationTestRunRecord['outcome']>; successfulRequests: number; attemptedRequests: number; estimatedCostUsd: number; modelProbability: number | null; anomalies: DonationRunAnomaly[] }): Promise<void> {
    const run = this.#testRuns.get(runId)
    if (!run || run.completedAt) return
    Object.assign(run, completion, { completedAt: new Date().toISOString() })
    const donation = this.#donations.get(run.donationId)
    if (donation) {
      donation.progressCurrent += completion.attemptedRequests
      donation.currentModel = [...this.#testRuns.values()].find((item) => item.cycleId === run.cycleId && !item.completedAt)?.model ?? null
    }
  }

  async listReadyDonationCycles(): Promise<DonationCycleRecord[]> {
    return [...this.#cycles.values()].filter((cycle) => cycle.status !== 'completed' && [...this.#testRuns.values()].filter((run) => run.cycleId === cycle.id).every((run) => run.completedAt)).map((item) => structuredClone(item))
  }

  async listDonationCycleRuns(cycleId: string): Promise<DonationTestRunRecord[]> {
    return [...this.#testRuns.values()].filter((item) => item.cycleId === cycleId).map((item) => structuredClone(item))
  }

  async finalizeDonationCycle(cycleId: string, spentUsd: number, errors: DonationError[], nextRunAt: string): Promise<void> {
    const cycle = this.#cycles.get(cycleId)
    if (!cycle || cycle.status === 'completed') return
    const donation = this.#donations.get(cycle.donationId)
    if (!donation) return
    cycle.status = 'completed'; cycle.actualCostUsd = spentUsd; cycle.completedAt = new Date().toISOString()
    const runs = [...this.#testRuns.values()].filter((item) => item.cycleId === cycleId)
    const available = runs.every((item) => item.outcome !== 'unavailable')
    donation.status = available ? 'active' : donation.status
    donation.phase = available ? 'active' : 'model_unavailable'
    donation.lastCheckedAt = cycle.completedAt
    donation.nextRunAt = available ? nextRunAt : new Date(Date.now() + 30 * 60_000).toISOString()
    donation.quotaSpentUsd += spentUsd
    donation.quotaReservedUsd = 0
    donation.errors = errors
    donation.currentModel = null
  }

  async createProposal(record: RegistryProposalRecord): Promise<void> {
    if (this.#proposals.has(record.id)) throw new AppError(409, 'proposal_exists', 'The proposal already exists.')
    this.#proposals.set(record.id, structuredClone(record))
  }

  async getProposal(id: string): Promise<RegistryProposalRecord | null> {
    const record = this.#proposals.get(id)
    return record ? structuredClone(record) : null
  }

  async close(): Promise<void> {
    this.#donations.clear()
    this.#donationIdempotency.clear()
    this.#proposals.clear()
    this.#cycles.clear()
    this.#testRuns.clear()
    this.#claims.clear()
  }
}
