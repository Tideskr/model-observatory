import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { RunStatus } from '../contracts/common.js'
import type { RunConfig } from '../contracts/private-runs.js'
import type { DatabasePool } from '../db/connection.js'
import { assertRunTransition } from '../domain/run-state.js'
import { AppError } from '../errors.js'
import { chainAuditEvent } from '../security/audit-chain.js'
import { LeaseLostError, type RunEvent, type RunLease, type RunRecord, type RunReport, type RunStore, type StoredObservation } from './run-store.js'

interface RunRow {
  id: string
  quote_id: string
  request_digest: string
  status: RunStatus
  evidence_source: RunRecord['evidenceSource'] | null
  target_origin: string
  target_base_url: string
  target_hostname: string
  model: string
  run_config: RunConfig
  disclosure_version: string
  scoring_release_id: string
  owner_token_hash: string
  idempotency_key: string
  credential_handle: string
  created_at: Date
  expires_at: Date
  worker_id: string | null
  lease_expires_at: Date | null
  lease_version: number
}

const runColumns = `id,quote_id,request_digest,status,evidence_source,target_origin,target_base_url,target_hostname,model,
  run_config,disclosure_version,scoring_release_id,owner_token_hash,idempotency_key,credential_handle,created_at,expires_at,
  worker_id,lease_expires_at,lease_version`

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    quoteId: row.quote_id,
    requestDigest: row.request_digest,
    status: row.status,
    ...(row.evidence_source ? { evidenceSource: row.evidence_source } : {}),
    targetOrigin: row.target_origin,
    targetBaseUrl: row.target_base_url,
    targetHostname: row.target_hostname,
    model: row.model,
    config: row.run_config,
    disclosureVersion: row.disclosure_version,
    scoringReleaseId: row.scoring_release_id,
    ownerTokenHash: row.owner_token_hash,
    idempotencyKey: row.idempotency_key,
    credentialHandle: row.credential_handle,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    leaseVersion: row.lease_version,
  }
}

function assertLease(row: RunRow, lease: RunLease): void {
  if (
    row.worker_id !== lease.workerId
    || row.lease_version !== lease.version
    || !row.lease_expires_at
    || row.lease_expires_at.getTime() <= Date.now()
  ) {
    throw new LeaseLostError()
  }
}

async function appendAudit(
  client: PoolClient,
  action: string,
  runId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('model-observatory-audit-chain'))")
  const previous = await client.query<{ event_hash: string }>('SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1')
  const event = chainAuditEvent(
    {
      action,
      subjectType: 'private_run',
      subjectId: runId,
      actorType: 'capability',
      payload,
      createdAt: new Date().toISOString(),
    },
    previous.rows[0]?.event_hash ?? null,
  )
  await client.query(
    `INSERT INTO audit_events
     (action,subject_type,subject_id,actor_type,actor_id_hash,payload,previous_hash,event_hash,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [event.action, event.subjectType, event.subjectId, event.actorType, event.actorIdHash ?? null, event.payload, event.previousHash, event.eventHash, event.createdAt],
  )
}

export class PostgresRunStore implements RunStore {
  constructor(private readonly pool: DatabasePool) {}

  async create(record: RunRecord): Promise<{ record: RunRecord; created: boolean }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query<RunRow>(
        `INSERT INTO private_runs
         (id,quote_id,request_digest,status,evidence_source,target_origin,target_base_url,target_hostname,model,run_config,
          disclosure_version,scoring_release_id,owner_token_hash,idempotency_key,credential_handle,expires_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${runColumns}`,
        [record.id, record.quoteId, record.requestDigest, record.status, record.evidenceSource ?? null, record.targetOrigin, record.targetBaseUrl, record.targetHostname, record.model, record.config, record.disclosureVersion, record.scoringReleaseId, record.ownerTokenHash, record.idempotencyKey, record.credentialHandle, record.expiresAt, record.createdAt],
      )
      let output = inserted.rows[0]
      let created = true
      if (!output) {
        const existing = await client.query<RunRow>(`SELECT ${runColumns} FROM private_runs WHERE idempotency_key = $1`, [record.idempotencyKey])
        output = existing.rows[0]
        created = false
        if (!output || output.request_digest !== record.requestDigest) {
          throw new AppError(409, 'idempotency_conflict', 'The idempotency key was already used for a different request.')
        }
      } else {
        await client.query('INSERT INTO run_events(run_id,event_type,payload) VALUES ($1,$2,$3)', [record.id, 'status', { status: record.status }])
        await appendAudit(client, 'run.created', record.id, { status: record.status, target_hostname: record.targetHostname, model: record.model })
      }
      await client.query('COMMIT')
      return { record: mapRun(output), created }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async get(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(`SELECT ${runColumns} FROM private_runs WHERE id = $1`, [runId])
    return result.rows[0] ? mapRun(result.rows[0]) : null
  }

  async transition(
    runId: string,
    status: RunStatus,
    eventType: string,
    payload: Record<string, unknown> = {},
    lease?: RunLease,
  ): Promise<RunRecord> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query<RunRow>(`SELECT ${runColumns} FROM private_runs WHERE id = $1 FOR UPDATE`, [runId])
      const current = selected.rows[0]
      if (!current) throw new AppError(404, 'run_not_found', 'The private run does not exist.')
      if (lease) assertLease(current, lease)
      if (current.status === status) {
        await client.query('COMMIT')
        return mapRun(current)
      }
      assertRunTransition(current.status, status)
      const terminal = ['completed', 'failed', 'cancelled', 'timed_out', 'incomplete'].includes(status)
      const updated = await client.query<RunRow>(
        `UPDATE private_runs SET status = $2, finished_at = CASE WHEN $3 THEN now() ELSE finished_at END,
         worker_id = CASE WHEN $3 THEN NULL ELSE worker_id END,
         lease_expires_at = CASE WHEN $3 THEN NULL ELSE lease_expires_at END
         WHERE id = $1 RETURNING ${runColumns}`,
        [runId, status, terminal],
      )
      await client.query('INSERT INTO run_events(run_id,event_type,payload) VALUES ($1,$2,$3)', [runId, eventType, { ...payload, status }])
      await appendAudit(client, `run.${eventType}`, runId, { ...payload, status })
      await client.query('COMMIT')
      return mapRun(updated.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listEvents(runId: string, afterId: string): Promise<RunEvent[]> {
    const result = await this.pool.query<{
      id: string
      run_id: string
      event_type: string
      payload: Record<string, unknown>
      created_at: Date
    }>(
      'SELECT id,run_id,event_type,payload,created_at FROM run_events WHERE run_id = $1 AND id > $2 ORDER BY id',
      [runId, afterId || '0'],
    )
    return result.rows.map((row) => ({
      id: String(row.id),
      runId: row.run_id,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    }))
  }

  async appendEvent(runId: string, eventType: string, payload: Record<string, unknown>, lease?: RunLease): Promise<void> {
    if (!lease) {
      await this.pool.query('INSERT INTO run_events(run_id,event_type,payload) VALUES ($1,$2,$3)', [runId, eventType, payload])
      return
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query<RunRow>(`SELECT ${runColumns} FROM private_runs WHERE id=$1 FOR UPDATE`, [runId])
      const current = selected.rows[0]
      if (!current) throw new AppError(404, 'run_not_found', 'The private run does not exist.')
      assertLease(current, lease)
      await client.query('INSERT INTO run_events(run_id,event_type,payload) VALUES ($1,$2,$3)', [runId, eventType, payload])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async claimNext(workerId: string, leaseSeconds: number): Promise<RunRecord | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query<RunRow>(
        `SELECT ${runColumns} FROM private_runs
         WHERE (status = 'queued' OR (status IN ('provisioning','running','scoring') AND (lease_expires_at IS NULL OR lease_expires_at < now())))
           AND expires_at > now()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED LIMIT 1`,
      )
      const current = selected.rows[0]
      if (!current) {
        await client.query('COMMIT')
        return null
      }
      const updated = await client.query<RunRow>(
        `UPDATE private_runs SET status='provisioning',worker_id=$2,lease_version=lease_version+1,
         lease_expires_at=now()+($3::text||' seconds')::interval,attempt_count=attempt_count+1
         WHERE id=$1 RETURNING ${runColumns}`,
        [current.id, workerId, leaseSeconds],
      )
      await client.query('INSERT INTO run_events(run_id,event_type,payload) VALUES ($1,$2,$3)', [current.id, 'provisioning', { status: 'provisioning' }])
      const workerIdHash = createHash('sha256').update(workerId).digest('hex')
      await appendAudit(client, 'run.provisioning', current.id, { status: 'provisioning', worker_id_hash: workerIdHash })
      await client.query('COMMIT')
      return mapRun(updated.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async renewLease(runId: string, lease: RunLease, leaseSeconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE private_runs SET lease_expires_at=now()+($3::text||' seconds')::interval
       WHERE id=$1 AND worker_id=$2 AND lease_version=$4 AND lease_expires_at > now()
         AND status IN ('provisioning','running','scoring')`,
      [runId, lease.workerId, leaseSeconds, lease.version],
    )
    return (result.rowCount ?? 0) > 0
  }

  async reserveAttempt(runId: string, jobId: string, maximumAttempts: number, lease: RunLease): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query<RunRow>(`SELECT ${runColumns} FROM private_runs WHERE id=$1 FOR UPDATE`, [runId])
      const current = selected.rows[0]
      if (!current) throw new AppError(404, 'run_not_found', 'The private run does not exist.')
      assertLease(current, lease)
      const attempts = await client.query<{ attempt_count: number }>(
        'SELECT attempt_count FROM run_job_attempts WHERE run_id=$1 AND job_id=$2',
        [runId, jobId],
      )
      const count = attempts.rows[0]?.attempt_count ?? 0
      if (count >= maximumAttempts) {
        await client.query('COMMIT')
        return false
      }
      await client.query(
        `INSERT INTO run_job_attempts(run_id,job_id,attempt_count) VALUES ($1,$2,1)
         ON CONFLICT (run_id,job_id) DO UPDATE SET attempt_count=run_job_attempts.attempt_count+1`,
        [runId, jobId],
      )
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async saveObservations(runId: string, observations: StoredObservation[], lease?: RunLease): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (lease) {
        const selected = await client.query<RunRow>(`SELECT ${runColumns} FROM private_runs WHERE id=$1 FOR UPDATE`, [runId])
        const current = selected.rows[0]
        if (!current) throw new AppError(404, 'run_not_found', 'The private run does not exist.')
        assertLease(current, lease)
      }
      for (const item of observations) {
        await client.query(
          `INSERT INTO run_observations
           (run_id,job_id,probe_id,profile,status,normalized_value,classification,hard_anomaly,elapsed_ms,safe_error,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (run_id,job_id) DO NOTHING`,
          [runId, item.jobId, item.probeId, item.profile, item.status, item.normalizedValue, item.classification, item.hardAnomaly, item.elapsedMs, item.safeError, item.metadata],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listObservations(runId: string): Promise<StoredObservation[]> {
    const result = await this.pool.query<{
      job_id: string; probe_id: string; profile: string; status: StoredObservation['status']; normalized_value: string | null;
      classification: string | null; hard_anomaly: boolean; elapsed_ms: number | null; safe_error: string | null;
      metadata: Record<string, unknown>
    }>(
      `SELECT job_id,probe_id,profile,status,normalized_value,classification,hard_anomaly,elapsed_ms,safe_error,metadata
       FROM run_observations WHERE run_id=$1 ORDER BY id`,
      [runId],
    )
    return result.rows.map((row) => ({
      jobId: row.job_id, probeId: row.probe_id, profile: row.profile, status: row.status,
      normalizedValue: row.normalized_value, classification: row.classification, hardAnomaly: row.hard_anomaly,
      elapsedMs: row.elapsed_ms, safeError: row.safe_error, metadata: row.metadata,
    }))
  }

  async finalize(
    runId: string,
    status: 'completed' | 'incomplete' | 'failed',
    observations: StoredObservation[],
    report: RunReport,
    lease: RunLease,
  ): Promise<RunRecord> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query<RunRow>(`SELECT ${runColumns} FROM private_runs WHERE id=$1 FOR UPDATE`, [runId])
      const current = selected.rows[0]
      if (!current) throw new AppError(404, 'run_not_found', 'The private run does not exist.')
      assertLease(current, lease)
      assertRunTransition(current.status, status)
      for (const item of observations) {
        await client.query(
          `INSERT INTO run_observations
           (run_id,job_id,probe_id,profile,status,normalized_value,classification,hard_anomaly,elapsed_ms,safe_error,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (run_id,job_id) DO NOTHING`,
          [runId, item.jobId, item.probeId, item.profile, item.status, item.normalizedValue, item.classification, item.hardAnomaly, item.elapsedMs, item.safeError, item.metadata],
        )
      }
      await client.query('INSERT INTO run_reports(run_id,status,report,created_at) VALUES ($1,$2,$3,$4)', [runId, status, report, report.createdAt])
      const updated = await client.query<RunRow>(
        `UPDATE private_runs SET status=$2,finished_at=now(),worker_id=NULL,lease_expires_at=NULL WHERE id=$1 RETURNING ${runColumns}`,
        [runId, status],
      )
      await client.query('INSERT INTO run_events(run_id,event_type,payload) VALUES ($1,$2,$3)', [runId, 'finished', { status }])
      await appendAudit(client, 'run.finished', runId, { status, observation_count: observations.length })
      await client.query('COMMIT')
      return mapRun(updated.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async saveReport(report: RunReport): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO run_reports(run_id,status,report,created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (run_id) DO NOTHING`,
      [report.runId, report.status, report, report.createdAt],
    )
    if (result.rowCount === 0) throw new AppError(409, 'report_exists', 'The run report is immutable.')
  }

  async getReport(runId: string): Promise<RunReport | null> {
    const result = await this.pool.query<{ report: RunReport }>('SELECT report FROM run_reports WHERE run_id = $1', [runId])
    return result.rows[0]?.report ?? null
  }

  async purge(runId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM run_observations WHERE run_id=$1', [runId])
      await client.query('DELETE FROM run_job_attempts WHERE run_id=$1', [runId])
      await client.query('DELETE FROM run_reports WHERE run_id=$1', [runId])
      await client.query('DELETE FROM run_events WHERE run_id=$1', [runId])
      await client.query('DELETE FROM private_runs WHERE id=$1', [runId])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query<{ id: string }>('SELECT id FROM private_runs WHERE expires_at <= $1 FOR UPDATE', [now])
      const ids = selected.rows.map((row) => row.id)
      if (ids.length === 0) {
        await client.query('COMMIT')
        return 0
      }
      for (const id of ids) await appendAudit(client, 'run.retention_purged', id, { reason: 'retention_expired' })
      await client.query('DELETE FROM run_observations WHERE run_id = ANY($1::uuid[])', [ids])
      await client.query('DELETE FROM run_job_attempts WHERE run_id = ANY($1::uuid[])', [ids])
      await client.query('DELETE FROM run_reports WHERE run_id = ANY($1::uuid[])', [ids])
      await client.query('DELETE FROM run_events WHERE run_id = ANY($1::uuid[])', [ids])
      await client.query('DELETE FROM private_runs WHERE id = ANY($1::uuid[])', [ids])
      await client.query('COMMIT')
      return ids.length
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {}
}
