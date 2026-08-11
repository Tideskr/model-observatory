import { resolve } from 'node:path'
import { loadConfig } from '../config.js'
import { createDatabasePool } from '../db/connection.js'
import { loadProviderRegistry } from './catalog.js'
import { syncProviderRegistry } from './sync.js'

const config = loadConfig()
if (config.databaseUrl === 'memory:') throw new Error('Registry sync requires PostgreSQL.')
const pool = createDatabasePool(config)
try {
  const registry = await loadProviderRegistry(resolve(process.cwd(), config.providerRegistryPath))
  await syncProviderRegistry(pool, registry)
  process.stdout.write(`Provider registry synced: ${registry.contentSha256}\n`)
} finally {
  await pool.end()
}
