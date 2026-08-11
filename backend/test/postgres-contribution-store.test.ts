import assert from 'node:assert/strict'
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
