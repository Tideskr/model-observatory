import type { PoolClient } from 'pg'
import type { DonationConstraints, DonationStatus, RegistryProposalField } from '../contracts/contributions.js'
import type { DatabasePool } from '../db/connection.js'
import { AppError } from '../errors.js'
import { chainAuditEvent } from '../security/audit-chain.js'
import type { ContributionStore, DonationRecord, RegistryProposalRecord } from './contribution-store.js'

interface DonationRow {
  id: string
  kind: 'api'
  status: DonationStatus
  target_origin: string
  target_base_url: string
  target_hostname: string
  constraints: DonationConstraints
  credential_handle: string
  credential_fingerprint_tail: string
  revocation_token_hash: string
  disclosure_version: string
  created_at: Date
  expires_at: Date
  revoked_at: Date | null
}

interface ProposalRow {
  id: string
  probe_id: string
  field_name: RegistryProposalField
  current_value: string
  proposed_value: string
  reason: string
  evidence_urls: string[]
  content_sha256: string
  status: 'gitops_pending'
  issue_url: string
  created_at: Date
}

const donationColumns = `id,kind,status,target_origin,target_base_url,target_hostname,constraints,credential_handle,
  credential_fingerprint_tail,revocation_token_hash,disclosure_version,created_at,expires_at,revoked_at`
const proposalColumns = `id,probe_id,field_name,current_value,proposed_value,reason,evidence_urls,
  content_sha256,status,issue_url,created_at`

function mapDonation(row: DonationRow): DonationRecord {
  return {
    id: row.id, kind: row.kind, status: row.status, targetOrigin: row.target_origin, targetBaseUrl: row.target_base_url,
    targetHostname: row.target_hostname, constraints: row.constraints, credentialHandle: row.credential_handle,
    credentialFingerprintTail: row.credential_fingerprint_tail, revocationTokenHash: row.revocation_token_hash,
    disclosureVersion: row.disclosure_version, createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null,
  }
}

function mapProposal(row: ProposalRow): RegistryProposalRecord {
  return {
    id: row.id, probeId: row.probe_id, field: row.field_name, currentValue: row.current_value,
    proposedValue: row.proposed_value, reason: row.reason, evidenceUrls: row.evidence_urls,
    contentSha256: row.content_sha256, status: row.status, issueUrl: row.issue_url,
    createdAt: row.created_at.toISOString(),
  }
}

async function appendAudit(
  client: PoolClient,
  action: string,
  subjectType: 'donation' | 'registry_proposal',
  subjectId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('model-observatory-audit-chain'))")
  const previous = await client.query<{ event_hash: string }>('SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1')
  const event = chainAuditEvent(
    { action, subjectType, subjectId, actorType: 'capability', payload, createdAt: new Date().toISOString() },
    previous.rows[0]?.event_hash ?? null,
  )
  await client.query(
    `INSERT INTO audit_events
     (action,subject_type,subject_id,actor_type,actor_id_hash,payload,previous_hash,event_hash,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [event.action, event.subjectType, event.subjectId, event.actorType, null, event.payload, event.previousHash, event.eventHash, event.createdAt],
  )
}

export class PostgresContributionStore implements ContributionStore {
  constructor(private readonly pool: DatabasePool) {}

  async createDonation(record: DonationRecord): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO donations
         (id,kind,status,target_origin,target_base_url,target_hostname,constraints,credential_handle,credential_fingerprint_tail,
          revocation_token_hash,disclosure_version,created_at,expires_at,revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [record.id, record.kind, record.status, record.targetOrigin, record.targetBaseUrl, record.targetHostname, record.constraints,
          record.credentialHandle, record.credentialFingerprintTail, record.revocationTokenHash,
          record.disclosureVersion, record.createdAt, record.expiresAt, record.revokedAt],
      )
      await appendAudit(client, 'donation.created', 'donation', record.id, {
        kind: record.kind, status: record.status, target_hostname: record.targetHostname,
        credential_fingerprint_tail: record.credentialFingerprintTail,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getDonation(id: string): Promise<DonationRecord | null> {
    const result = await this.pool.query<DonationRow>(`SELECT ${donationColumns} FROM donations WHERE id=$1`, [id])
    return result.rows[0] ? mapDonation(result.rows[0]) : null
  }

  async revokeDonation(id: string, revokedAt: string): Promise<DonationRecord> {
    return this.#transitionDonation(id, 'revoked', revokedAt)
  }

  async expireDonation(id: string): Promise<DonationRecord> {
    return this.#transitionDonation(id, 'expired', null)
  }

  async #transitionDonation(id: string, status: 'revoked' | 'expired', revokedAt: string | null): Promise<DonationRecord> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<DonationRow>(
        `UPDATE donations SET status = CASE WHEN status='revoked' THEN status ELSE $2 END,
         revoked_at = CASE WHEN status='revoked' THEN revoked_at ELSE COALESCE($3,revoked_at) END
         WHERE id=$1 RETURNING ${donationColumns}`,
        [id, status, revokedAt],
      )
      const record = result.rows[0]
      if (!record) throw new AppError(404, 'donation_not_found', 'The donation does not exist.')
      await appendAudit(client, `donation.${status}`, 'donation', id, { status: record.status })
      await client.query('COMMIT')
      return mapDonation(record)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async createProposal(record: RegistryProposalRecord): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO registry_proposals
         (id,probe_id,field_name,current_value,proposed_value,reason,evidence_urls,content_sha256,status,issue_url,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [record.id, record.probeId, record.field, record.currentValue, record.proposedValue, record.reason,
          record.evidenceUrls, record.contentSha256, record.status, record.issueUrl, record.createdAt],
      )
      await appendAudit(client, 'registry_proposal.created', 'registry_proposal', record.id, {
        probe_id: record.probeId, field: record.field, content_sha256: record.contentSha256,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getProposal(id: string): Promise<RegistryProposalRecord | null> {
    const result = await this.pool.query<ProposalRow>(`SELECT ${proposalColumns} FROM registry_proposals WHERE id=$1`, [id])
    return result.rows[0] ? mapProposal(result.rows[0]) : null
  }

  async close(): Promise<void> {}
}
