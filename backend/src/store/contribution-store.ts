import type { DonationConstraints, DonationStatus, RegistryProposalField } from '../contracts/contributions.js'
import { AppError } from '../errors.js'

export interface DonationRecord {
  id: string
  kind: 'api'
  status: DonationStatus
  targetOrigin: string
  targetBaseUrl: string
  targetHostname: string
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

export interface ContributionStore {
  createDonation(record: DonationRecord): Promise<void>
  getDonation(id: string): Promise<DonationRecord | null>
  revokeDonation(id: string, revokedAt: string): Promise<DonationRecord>
  expireDonation(id: string): Promise<DonationRecord>
  createProposal(record: RegistryProposalRecord): Promise<void>
  getProposal(id: string): Promise<RegistryProposalRecord | null>
  close(): Promise<void>
}

export class MemoryContributionStore implements ContributionStore {
  readonly #donations = new Map<string, DonationRecord>()
  readonly #proposals = new Map<string, RegistryProposalRecord>()

  async createDonation(record: DonationRecord): Promise<void> {
    if (this.#donations.has(record.id)) throw new AppError(409, 'donation_exists', 'The donation already exists.')
    this.#donations.set(record.id, structuredClone(record))
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
    return structuredClone(record)
  }

  async expireDonation(id: string): Promise<DonationRecord> {
    const record = this.#donations.get(id)
    if (!record) throw new AppError(404, 'donation_not_found', 'The donation does not exist.')
    if (record.status !== 'revoked') record.status = 'expired'
    return structuredClone(record)
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
    this.#proposals.clear()
  }
}
