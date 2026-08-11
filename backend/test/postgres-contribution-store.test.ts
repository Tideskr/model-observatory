import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import type { DatabasePool } from '../src/db/connection.js'
import { PostgresContributionStore } from '../src/store/postgres-contribution-store.js'

test('claiming a donation does not expose an ambiguous id from the candidate CTE', async () => {
  const queries: Array<{ sql: string; values: unknown[] | undefined }> = []
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values })
      return { rows: [] }
    },
  } as unknown as DatabasePool

  const store = new PostgresContributionStore(pool)
  assert.equal(await store.claimDueDonation('worker-test', 60), null)

  assert.equal(queries.length, 1)
  assert.match(queries[0]!.sql, /SELECT id AS donation_id FROM donations/)
  assert.match(queries[0]!.sql, /WHERE d\.id=candidate\.donation_id RETURNING/)
  assert.doesNotMatch(queries[0]!.sql, /SELECT id FROM donations/)
  assert.deepEqual(queries[0]!.values, ['worker-test', 60])
})

test('donation worker updates encode error lists as JSON instead of PostgreSQL arrays', async () => {
  const now = new Date()
  const row = {
    id: '10000000-0000-4000-8000-000000000001', quote_id: '10000000-0000-4000-8000-000000000002',
    request_digest: 'a'.repeat(64), idempotency_key: 'postgres-error-json-test', kind: 'api', status: 'quarantined',
    target_origin: 'https://api.example.com', target_base_url: 'https://api.example.com/v1', target_hostname: 'api.example.com',
    provider_slug: 'example', group_id: 'default', detected_group_id: null, group_attribution: 'pending', phase: 'identity_probe',
    progress_current: 0, progress_total: 128, current_model: null, next_run_at: now, last_checked_at: null,
    quota_spent_usd: '0', quota_reserved_usd: '0', errors: {}, constraints: { quota_usd: 20, concurrency: 4, interval_minutes: 240, expires_in_days: 30 },
    credential_handle: '10000000-0000-4000-8000-000000000003', credential_fingerprint_tail: '0123456789',
    revocation_token_hash: 'b'.repeat(64), disclosure_version: 'donation-api-v1', created_at: now,
    expires_at: new Date(now.getTime() + 86_400_000), revoked_at: null,
  }
  const queries: Array<{ sql: string; values: unknown[] | undefined }> = []
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values })
      return { rows: [row] }
    },
  } as unknown as DatabasePool
  const error = {
    stage: 'scheduler', code: 'scheduler_failed', message: 'Failed to create a cycle.', model: null,
    http_status: null, retryable: true, at: now.toISOString(),
  }

  const store = new PostgresContributionStore(pool)
  const updated = await store.updateDonationFromWorker(row.id, 'worker-test', { errors: [error] }, true)

  assert.deepEqual(updated.errors, [])
  assert.equal(queries.length, 2)
  assert.equal(queries[1]!.values?.[13], JSON.stringify([error]))
})

test('donation scheduler repair migration permits idle scheduling and normalizes error details', async () => {
  const migration = await readFile(resolve(process.cwd(), 'migrations/008_donation_scheduler_repairs.sql'), 'utf8')
  assert.match(migration, /ALTER COLUMN next_run_at DROP NOT NULL/)
  assert.match(migration, /jsonb_typeof\(errors\) IS DISTINCT FROM 'array'/)
  assert.match(migration, /donations_errors_array CHECK \(jsonb_typeof\(errors\) = 'array'\)/)
})

test('cycle creation rechecks donation status while holding the donation row lock', async () => {
  const queries: string[] = []
  const client = {
    query: async (sql: string) => {
      queries.push(sql)
      if (sql.includes('SELECT id FROM donations')) return { rowCount: 0, rows: [] }
      return { rowCount: 0, rows: [] }
    },
    release: () => undefined,
  }
  const pool = { connect: async () => client } as unknown as DatabasePool
  const store = new PostgresContributionStore(pool)

  await assert.rejects(() => store.createDonationCycle({
    id: '10000000-0000-4000-8000-000000000010', donationId: '10000000-0000-4000-8000-000000000011',
    status: 'running', attribution: 'verified', reservedCostUsd: 1, actualCostUsd: 0,
    createdAt: new Date().toISOString(), completedAt: null,
  }, [], 'worker-test'))
  const lockQuery = queries.find((sql) => sql.includes('SELECT id FROM donations'))
  assert.ok(lockQuery)
  assert.match(lockQuery, /status IN \('quarantined','active'\)/)
  assert.ok(queries.includes('ROLLBACK'))
})

test('model confidence migration derives probability rather than binary pass rate', async () => {
  const migration = await readFile(resolve(process.cwd(), 'migrations/009_model_probability_confidence.sql'), 'utf8')
  assert.match(migration, /ADD COLUMN model_probability/)
  assert.match(migration, /conditional_relative_probability/)
  assert.match(migration, /round\(100\.0\*avg\(model_probability\)\)/)
  assert.doesNotMatch(migration, /outcome='pass'/)
})
