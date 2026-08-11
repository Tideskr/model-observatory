import type { PoolClient } from 'pg'
import type { DonationConstraints, DonationError, DonationStatus, RegistryProposalField } from '../contracts/contributions.js'
import type { DatabasePool } from '../db/connection.js'
import { AppError } from '../errors.js'
import { chainAuditEvent } from '../security/audit-chain.js'
import type {
  ContributionStore, DonationCycleRecord, DonationRecord, DonationRunAnomaly, DonationTestRunRecord,
  DonationWorkerPatch, RegistryProposalRecord,
} from './contribution-store.js'

interface DonationRow {
  id: string
  quote_id: string
  request_digest: string
  idempotency_key: string
  kind: 'api'
  status: DonationStatus
  target_origin: string
  target_base_url: string
  target_hostname: string
  provider_slug: string
  group_id: string
  detected_group_id: string | null
  group_attribution: DonationRecord['groupAttribution']
  phase: string
  progress_current: number
  progress_total: number
  current_model: string | null
  next_run_at: Date | null
  last_checked_at: Date | null
  quota_spent_usd: string
  quota_reserved_usd: string
  errors: DonationError[]
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

const donationColumns = `id,quote_id,request_digest,idempotency_key,kind,status,target_origin,target_base_url,target_hostname,
  provider_slug,group_id,detected_group_id,group_attribution,phase,progress_current,progress_total,current_model,next_run_at,last_checked_at,
  quota_spent_usd,quota_reserved_usd,errors,constraints,credential_handle,credential_fingerprint_tail,revocation_token_hash,
  disclosure_version,created_at,expires_at,revoked_at`
const proposalColumns = `id,probe_id,field_name,current_value,proposed_value,reason,evidence_urls,
  content_sha256,status,issue_url,created_at`

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function donationErrorsJson(errors: DonationError[]): string {
  return JSON.stringify(errors)
}

function mapDonation(row: DonationRow): DonationRecord {
  return {
    id: row.id, quoteId: row.quote_id, requestDigest: row.request_digest, idempotencyKey: row.idempotency_key,
    kind: row.kind, status: row.status, targetOrigin: row.target_origin, targetBaseUrl: row.target_base_url,
    targetHostname: row.target_hostname, providerSlug: row.provider_slug, groupId: row.group_id,
    detectedGroupId: row.detected_group_id, groupAttribution: row.group_attribution, phase: row.phase,
    progressCurrent: row.progress_current, progressTotal: row.progress_total, currentModel: row.current_model,
    nextRunAt: row.next_run_at?.toISOString() ?? null, lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    quotaSpentUsd: Number(row.quota_spent_usd), quotaReservedUsd: Number(row.quota_reserved_usd),
    errors: Array.isArray(row.errors) ? row.errors : [],
    constraints: row.constraints, credentialHandle: row.credential_handle,
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

  async createDonation(record: DonationRecord): Promise<{ record: DonationRecord; created: boolean }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query<DonationRow>(
        `INSERT INTO donations
         (id,quote_id,request_digest,idempotency_key,kind,status,target_origin,target_base_url,target_hostname,constraints,
          credential_handle,credential_fingerprint_tail,revocation_token_hash,disclosure_version,created_at,expires_at,revoked_at,
          provider_slug,group_id,detected_group_id,group_attribution,phase,progress_current,progress_total,current_model,next_run_at,last_checked_at,
          quota_spent_usd,quota_reserved_usd,errors)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${donationColumns}`,
        [record.id, record.quoteId, record.requestDigest, record.idempotencyKey, record.kind, record.status,
          record.targetOrigin, record.targetBaseUrl, record.targetHostname, record.constraints,
          record.credentialHandle, record.credentialFingerprintTail, record.revocationTokenHash,
          record.disclosureVersion, record.createdAt, record.expiresAt, record.revokedAt,
          record.providerSlug, record.groupId, record.detectedGroupId, record.groupAttribution, record.phase,
          record.progressCurrent, record.progressTotal, record.currentModel, record.nextRunAt, record.lastCheckedAt,
          record.quotaSpentUsd, record.quotaReservedUsd, donationErrorsJson(record.errors)],
      )
      let output = inserted.rows[0]
      let created = true
      if (!output) {
        const existing = await client.query<DonationRow>(
          `SELECT ${donationColumns} FROM donations WHERE idempotency_key=$1`,
          [record.idempotencyKey],
        )
        output = existing.rows[0]
        created = false
        if (!output || output.request_digest !== record.requestDigest) {
          throw new AppError(409, 'idempotency_conflict', 'The idempotency key was already used for a different request.')
        }
      } else {
        await appendAudit(client, 'donation.created', 'donation', record.id, {
          kind: record.kind, status: record.status, target_hostname: record.targetHostname,
          credential_fingerprint_tail: record.credentialFingerprintTail,
        })
      }
      await client.query('COMMIT')
      return { record: mapDonation(output), created }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getDonation(id: string): Promise<DonationRecord | null> {
    const result = await this.pool.query<DonationRow>(`SELECT ${donationColumns} FROM donations WHERE id=$1`, [id])
    if (!result.rows[0]) return null
    const record = mapDonation(result.rows[0])
    if (record.phase === 'testing') {
      const progress = await this.pool.query<{ model: string; payload: Record<string, unknown> | null }>(
        `SELECT r.model,(SELECT payload FROM run_events e WHERE e.run_id=r.private_run_id
          AND e.event_type IN ('started','progress','scoring') ORDER BY e.id DESC LIMIT 1) payload
         FROM donation_test_runs r JOIN private_runs p ON p.id=r.private_run_id
         WHERE r.donation_id=$1 AND r.completed_at IS NULL AND p.status IN ('provisioning','running','scoring')
         ORDER BY p.created_at LIMIT 1`, [id],
      )
      const active = progress.rows[0]
      if (active) {
        record.currentModel = active.model
        record.progressCurrent = Math.min(record.progressTotal, record.progressCurrent + numberValue(active.payload?.['completed']))
      }
    }
    return record
  }

  async revokeDonation(id: string, revokedAt: string): Promise<DonationRecord> {
    return this.#transitionDonation(id, 'revoked', revokedAt)
  }

  async expireDonation(id: string): Promise<DonationRecord> {
    return this.#transitionDonation(id, 'expired', null)
  }

  async claimDueDonation(workerId: string, leaseSeconds: number): Promise<DonationRecord | null> {
    const result = await this.pool.query<DonationRow>(
      `WITH candidate AS (
         SELECT id AS donation_id FROM donations
         WHERE status IN ('quarantined','active') AND next_run_at <= now() AND expires_at > now()
           AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         ORDER BY next_run_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE donations d SET worker_id=$1,lease_expires_at=now()+($2::text || ' seconds')::interval,
         phase=CASE WHEN d.status='quarantined' THEN 'identity_probe' ELSE 'scheduling' END
       FROM candidate WHERE d.id=candidate.donation_id RETURNING ${donationColumns}`,
      [workerId, leaseSeconds],
    )
    return result.rows[0] ? mapDonation(result.rows[0]) : null
  }

  async updateDonationFromWorker(id: string, workerId: string, patch: DonationWorkerPatch, releaseLease = false): Promise<DonationRecord> {
    const current = await this.getDonation(id)
    if (!current) throw new AppError(404, 'donation_not_found', 'The donation does not exist.')
    const next = { ...current, ...patch }
    const result = await this.pool.query<DonationRow>(
      `UPDATE donations SET status=$3,detected_group_id=$4,group_attribution=$5,phase=$6,progress_current=$7,
         progress_total=$8,current_model=$9,next_run_at=$10,last_checked_at=$11,quota_spent_usd=$12,
         quota_reserved_usd=$13,errors=$14,worker_id=CASE WHEN $15 THEN NULL ELSE worker_id END,
         lease_expires_at=CASE WHEN $15 THEN NULL ELSE lease_expires_at END
       WHERE id=$1 AND worker_id=$2 AND lease_expires_at>now() RETURNING ${donationColumns}`,
      [id, workerId, next.status, next.detectedGroupId, next.groupAttribution, next.phase, next.progressCurrent,
        next.progressTotal, next.currentModel, next.nextRunAt, next.lastCheckedAt, next.quotaSpentUsd,
        next.quotaReservedUsd, donationErrorsJson(next.errors), releaseLease],
    )
    if (!result.rows[0]) throw new AppError(409, 'donation_lease_lost', 'The donation worker lease was lost.')
    return mapDonation(result.rows[0])
  }

  async createDonationCycle(cycle: DonationCycleRecord, runs: DonationTestRunRecord[], workerId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const owned = await client.query('SELECT id FROM donations WHERE id=$1 AND worker_id=$2 AND lease_expires_at>now() FOR UPDATE', [cycle.donationId, workerId])
      if (!owned.rowCount) throw new AppError(409, 'donation_lease_lost', 'The donation worker lease was lost.')
      await client.query(
        `INSERT INTO donation_cycles(id,donation_id,status,attribution,reserved_cost_usd,actual_cost_usd,created_at,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [cycle.id, cycle.donationId, cycle.status, cycle.attribution, cycle.reservedCostUsd, cycle.actualCostUsd, cycle.createdAt, cycle.completedAt],
      )
      for (const run of runs) await client.query(
        `INSERT INTO donation_test_runs(cycle_id,donation_id,private_run_id,provider_slug,group_id,model,attribution)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [run.cycleId, run.donationId, run.privateRunId, run.providerSlug, run.groupId, run.model, run.attribution],
      )
      await client.query(
        `UPDATE donations SET phase='testing',progress_current=0,current_model=$3,next_run_at=NULL,
         quota_reserved_usd=$4,worker_id=NULL,lease_expires_at=NULL WHERE id=$1 AND worker_id=$2`,
        [cycle.donationId, workerId, runs[0]?.model ?? null, cycle.reservedCostUsd],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async listPendingDonationRuns(): Promise<DonationTestRunRecord[]> {
    const result = await this.pool.query<{
      cycle_id: string; donation_id: string; private_run_id: string; provider_slug: string; group_id: string; model: string;
      attribution: DonationTestRunRecord['attribution']; outcome: DonationTestRunRecord['outcome']; successful_requests: number | null;
      attempted_requests: number | null; estimated_cost_usd: string | null; completed_at: Date | null
    }>(`SELECT cycle_id,donation_id,private_run_id,provider_slug,group_id,model,attribution,outcome,
        successful_requests,attempted_requests,estimated_cost_usd,completed_at
        FROM donation_test_runs WHERE completed_at IS NULL AND excluded=false ORDER BY cycle_id,model`)
    return result.rows.map((row) => ({
      cycleId: row.cycle_id, donationId: row.donation_id, privateRunId: row.private_run_id,
      providerSlug: row.provider_slug, groupId: row.group_id, model: row.model, attribution: row.attribution,
      outcome: row.outcome, successfulRequests: row.successful_requests, attemptedRequests: row.attempted_requests,
      estimatedCostUsd: row.estimated_cost_usd == null ? null : Number(row.estimated_cost_usd),
      completedAt: row.completed_at?.toISOString() ?? null,
    }))
  }

  async completeDonationRun(runId: string, completion: { outcome: NonNullable<DonationTestRunRecord['outcome']>; successfulRequests: number; attemptedRequests: number; estimatedCostUsd: number; anomalies: DonationRunAnomaly[] }): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const updated = await client.query<{ cycle_id: string; donation_id: string; provider_slug: string; group_id: string; model: string; attribution: DonationTestRunRecord['attribution'] }>(
        `UPDATE donation_test_runs SET outcome=$2,successful_requests=$3,attempted_requests=$4,
         estimated_cost_usd=$5,completed_at=now() WHERE private_run_id=$1 AND completed_at IS NULL AND excluded=false
         RETURNING cycle_id,donation_id,provider_slug,group_id,model,attribution`,
        [runId, completion.outcome, completion.successfulRequests, completion.attemptedRequests, completion.estimatedCostUsd],
      )
      const row = updated.rows[0]
      if (!row) { await client.query('COMMIT'); return }
      const donation = await client.query<{ credential_fingerprint_tail: string }>('SELECT credential_fingerprint_tail FROM donations WHERE id=$1', [row.donation_id])
      for (const anomaly of completion.anomalies) await client.query(
        `INSERT INTO public_anomalies(id,provider_slug,observed_at,channel_display,source,model,group_id,probe_id,
          expected_display,observed_display,severity,scoring_release_id)
         SELECT $1,$2,now(),$3,'donated',$4,$5,$6,$7,$8,$9,scoring_release_id FROM private_runs WHERE id=$10
         ON CONFLICT (id) DO NOTHING`,
        [anomaly.id, row.provider_slug, `捐赠凭据 · ${donation.rows[0]?.credential_fingerprint_tail ?? 'unknown'}`,
          row.model, row.group_id, anomaly.probeId, anomaly.expected, anomaly.observed, anomaly.severity, runId],
      )
      const nextModel = await client.query<{ model: string }>(
        'SELECT model FROM donation_test_runs WHERE cycle_id=$1 AND completed_at IS NULL AND excluded=false ORDER BY model LIMIT 1', [row.cycle_id],
      )
      await client.query(
        `UPDATE donations SET progress_current=LEAST(progress_total,progress_current+$2),current_model=$3 WHERE id=$1`,
        [row.donation_id, completion.attemptedRequests, nextModel.rows[0]?.model ?? null],
      )
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async listReadyDonationCycles(): Promise<DonationCycleRecord[]> {
    const result = await this.pool.query<{ id: string; donation_id: string; status: DonationCycleRecord['status']; attribution: DonationCycleRecord['attribution']; reserved_cost_usd: string; actual_cost_usd: string; created_at: Date; completed_at: Date | null }>(
      `SELECT c.id,c.donation_id,c.status,c.attribution,c.reserved_cost_usd,c.actual_cost_usd,c.created_at,c.completed_at
       FROM donation_cycles c WHERE c.status IN ('scheduled','running')
       AND NOT EXISTS (SELECT 1 FROM donation_test_runs r WHERE r.cycle_id=c.id AND r.completed_at IS NULL AND r.excluded=false)`,
    )
    return result.rows.map((row) => ({ id: row.id, donationId: row.donation_id, status: row.status,
      attribution: row.attribution, reservedCostUsd: Number(row.reserved_cost_usd), actualCostUsd: Number(row.actual_cost_usd),
      createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null }))
  }

  async listDonationCycleRuns(cycleId: string): Promise<DonationTestRunRecord[]> {
    return (await this.listPendingAndCompletedCycleRuns(cycleId))
  }

  private async listPendingAndCompletedCycleRuns(cycleId: string): Promise<DonationTestRunRecord[]> {
    const result = await this.pool.query<{
      cycle_id: string; donation_id: string; private_run_id: string; provider_slug: string; group_id: string; model: string;
      attribution: DonationTestRunRecord['attribution']; outcome: DonationTestRunRecord['outcome']; successful_requests: number | null;
      attempted_requests: number | null; estimated_cost_usd: string | null; completed_at: Date | null
    }>(`SELECT cycle_id,donation_id,private_run_id,provider_slug,group_id,model,attribution,outcome,
        successful_requests,attempted_requests,estimated_cost_usd,completed_at FROM donation_test_runs WHERE cycle_id=$1 ORDER BY model`, [cycleId])
    return result.rows.map((row) => ({ cycleId: row.cycle_id, donationId: row.donation_id, privateRunId: row.private_run_id,
      providerSlug: row.provider_slug, groupId: row.group_id, model: row.model, attribution: row.attribution,
      outcome: row.outcome, successfulRequests: row.successful_requests, attemptedRequests: row.attempted_requests,
      estimatedCostUsd: row.estimated_cost_usd == null ? null : Number(row.estimated_cost_usd), completedAt: row.completed_at?.toISOString() ?? null }))
  }

  async finalizeDonationCycle(cycleId: string, spentUsd: number, errors: DonationError[], nextRunAt: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query<{ donation_id: string; donation_status: DonationStatus }>(
        `SELECT c.donation_id,d.status donation_status FROM donation_cycles c JOIN donations d ON d.id=c.donation_id
         WHERE c.id=$1 AND c.status<>'completed' FOR UPDATE`, [cycleId],
      )
      const donationId = selected.rows[0]?.donation_id
      if (!donationId) { await client.query('COMMIT'); return }
      if (['revoked', 'expired', 'rejected'].includes(selected.rows[0]!.donation_status)) {
        await client.query("UPDATE donation_cycles SET status='blocked',completed_at=now() WHERE id=$1", [cycleId])
        await client.query('COMMIT')
        return
      }
      const runs = await client.query<{ provider_slug: string; group_id: string; model: string; outcome: DonationTestRunRecord['outcome'] }>('SELECT provider_slug,group_id,model,outcome FROM donation_test_runs WHERE cycle_id=$1 AND excluded=false', [cycleId])
      const available = runs.rows.length > 0 && runs.rows.every((item) => item.outcome !== 'unavailable')
      await client.query('UPDATE donation_cycles SET status=\'completed\',actual_cost_usd=$2,completed_at=now() WHERE id=$1', [cycleId, spentUsd])
      await client.query(
        `UPDATE donations SET status=CASE WHEN $2 THEN 'active' ELSE status END,
         phase=CASE WHEN $2 THEN 'active' ELSE 'model_unavailable' END,last_checked_at=now(),
         next_run_at=CASE WHEN $2 THEN $3 ELSE now()+interval '30 minutes' END,
         quota_spent_usd=quota_spent_usd+$4,quota_reserved_usd=0,errors=$5,current_model=NULL WHERE id=$1`,
        [donationId, available, nextRunAt, spentUsd, donationErrorsJson(errors)],
      )
      const keys = new Set(runs.rows.map((item) => `${item.provider_slug}\0${item.group_id}\0${item.model}`))
      for (const key of keys) {
        const [providerSlug, groupId, model] = key.split('\0')
        await client.query(
          `INSERT INTO provider_source_scores(provider_slug,group_id,model,source,confidence,samples,availability,
             attempted_samples,inconclusive_samples,verified_samples,declared_samples)
           SELECT $1,$2,$3,'donated',
             round(100.0*count(*) FILTER (WHERE outcome='pass')/NULLIF(count(*) FILTER (WHERE outcome IN ('pass','fail')),0))::integer,
             count(*) FILTER (WHERE outcome IN ('pass','fail'))::integer,
             round(100.0*sum(successful_requests)/NULLIF(sum(attempted_requests),0))::integer,
             COALESCE(sum(attempted_requests),0)::integer,count(*) FILTER (WHERE outcome='inconclusive')::integer,
             count(*) FILTER (WHERE attribution='verified')::integer,count(*) FILTER (WHERE attribution='donor_declared')::integer
           FROM donation_test_runs WHERE provider_slug=$1 AND group_id=$2 AND model=$3 AND excluded=false AND completed_at>=now()-interval '30 days'
           ON CONFLICT (provider_slug,group_id,model,source) DO UPDATE SET confidence=excluded.confidence,
             samples=excluded.samples,availability=excluded.availability,attempted_samples=excluded.attempted_samples,
             inconclusive_samples=excluded.inconclusive_samples,verified_samples=excluded.verified_samples,
             declared_samples=excluded.declared_samples`,
          [providerSlug, groupId, model],
        )
        await client.query('UPDATE providers SET last_checked_at=now(),updated_at=now() WHERE slug=$1', [providerSlug])
        await client.query(
          `INSERT INTO provider_history(provider_slug,bucket_at,confidence)
           SELECT $1,date_trunc('day',now()),round(avg(confidence))::integer
           FROM provider_source_scores WHERE provider_slug=$1 AND source IN ('donated','community') AND confidence IS NOT NULL
           HAVING count(confidence)>0
           ON CONFLICT (provider_slug,bucket_at) DO UPDATE SET confidence=excluded.confidence`,
          [providerSlug],
        )
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
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
      await client.query('UPDATE donation_test_runs SET excluded=true WHERE donation_id=$1', [id])
      await client.query("UPDATE donation_cycles SET status='blocked',completed_at=now() WHERE donation_id=$1 AND status IN ('scheduled','running')", [id])
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
