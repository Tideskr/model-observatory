import { loadConfig } from '../config.js'
import { createDatabasePool } from './connection.js'
import { migrate } from './migrate.js'

const pool = createDatabasePool(loadConfig())
try {
  const applied = await migrate(pool)
  process.stdout.write(applied.length ? `Applied: ${applied.join(', ')}\n` : 'Database is current.\n')
} finally {
  await pool.end()
}
