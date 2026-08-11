import pg from 'pg'
import type { AppConfig } from '../config.js'

const { Pool } = pg

export type DatabasePool = InstanceType<typeof Pool>

export function createDatabasePool(config: AppConfig): DatabasePool {
  if (config.databaseUrl === 'memory:') {
    throw new Error('PostgreSQL is required for database commands; DATABASE_URL is memory:')
  }
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'model-observatory-api',
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  })
}
