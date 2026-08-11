import { loadConfig } from './config.js'
import { createDatabasePool } from './db/connection.js'
import { PostgresCredentialVault } from './security/credential-vault.js'
import { loadScoringRelease } from './scoring/repository.js'
import { PostgresRunStore } from './store/postgres-run-store.js'
import { RunWorker } from './worker/run-worker.js'
import { PostgresPublicRepository } from './store/postgres-public-repository.js'
import { PostgresContributionStore } from './store/postgres-contribution-store.js'
import { loadProviderRegistry } from './registry/catalog.js'
import { resolve } from 'node:path'
import { DonationScheduler } from './worker/donation-scheduler.js'

const config = loadConfig()
if (config.databaseUrl === 'memory:') throw new Error('The standalone worker requires PostgreSQL.')
const pool = createDatabasePool(config)
const providerRegistry = await loadProviderRegistry(resolve(process.cwd(), config.providerRegistryPath))
const runStore = new PostgresRunStore(pool)
const credentialVault = new PostgresCredentialVault(pool, config.credentialMasterKey)
const services = {
  runStore,
  credentialVault,
  publicRepository: new PostgresPublicRepository(pool, config.scoringReleaseId),
  contributionStore: new PostgresContributionStore(pool),
  providerRegistry,
  async close() { await pool.end() },
}
const worker = new RunWorker({
  services,
  loadScoringRelease: (releaseId) => loadScoringRelease(pool, releaseId),
})
const controller = new AbortController()
const donations = new DonationScheduler({ config, services })
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
try {
  const donationLoop = async () => {
    while (!controller.signal.aborted) {
      const reconciled = await donations.reconcileOnce()
      const scheduled = await donations.scheduleOnce()
      if (!reconciled && !scheduled) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }
  }
  await Promise.all([worker.run(controller.signal), donationLoop()])
} finally {
  await services.close()
}
