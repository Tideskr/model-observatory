import { loadConfig } from './config.js'
import { createDatabasePool } from './db/connection.js'
import { PostgresCredentialVault } from './security/credential-vault.js'
import { loadScoringRelease } from './scoring/repository.js'
import { PostgresRunStore } from './store/postgres-run-store.js'
import { RunWorker } from './worker/run-worker.js'
import { PostgresPublicRepository } from './store/postgres-public-repository.js'
import { PostgresContributionStore } from './store/postgres-contribution-store.js'

const config = loadConfig()
if (config.databaseUrl === 'memory:') throw new Error('The standalone worker requires PostgreSQL.')
const pool = createDatabasePool(config)
const runStore = new PostgresRunStore(pool)
const credentialVault = new PostgresCredentialVault(pool, config.credentialMasterKey)
const services = {
  runStore,
  credentialVault,
  publicRepository: new PostgresPublicRepository(pool, config.scoringReleaseId),
  contributionStore: new PostgresContributionStore(pool),
  async close() { await pool.end() },
}
const worker = new RunWorker({
  services,
  loadScoringRelease: (releaseId) => loadScoringRelease(pool, releaseId),
})
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
try {
  await worker.run(controller.signal)
} finally {
  await services.close()
}
