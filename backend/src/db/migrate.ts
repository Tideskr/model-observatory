import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DatabasePool } from './connection.js'

export async function migrate(pool: DatabasePool, directory = resolve(process.cwd(), 'migrations')): Promise<string[]> {
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).toSorted()
  const applied: string[] = []

  for (const file of files) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      )
      const existing = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [file],
      )
      if (existing.rowCount === 0) {
        await client.query(await readFile(resolve(directory, file), 'utf8'))
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file])
        applied.push(file)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  return applied
}
