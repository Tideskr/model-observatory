import type { AppConfig } from './config.js'
import { MemoryCredentialVault, type CredentialVault } from './security/credential-vault.js'
import { MemoryRunStore } from './store/memory-run-store.js'
import type { RunStore } from './store/run-store.js'
import { createDatabasePool } from './db/connection.js'
import { PostgresCredentialVault } from './security/credential-vault.js'
import { PostgresRunStore } from './store/postgres-run-store.js'
import { MemoryPublicRepository, type PublicRepository } from './store/public-repository.js'
import { PostgresPublicRepository } from './store/postgres-public-repository.js'
import { MemoryContributionStore, type ContributionStore } from './store/contribution-store.js'
import { PostgresContributionStore } from './store/postgres-contribution-store.js'

export interface AppServices {
  runStore: RunStore
  credentialVault: CredentialVault
  publicRepository: PublicRepository
  contributionStore: ContributionStore
  close(): Promise<void>
}

export function createMemoryServices(config: AppConfig): AppServices {
  const runStore = new MemoryRunStore()
  const credentialVault = new MemoryCredentialVault(config.credentialMasterKey)
  const publicRepository = new MemoryPublicRepository()
  const contributionStore = new MemoryContributionStore()
  return {
    runStore,
    credentialVault,
    publicRepository,
    contributionStore,
    async close() {
      await Promise.all([runStore.close(), credentialVault.close(), contributionStore.close()])
    },
  }
}

export function createServices(config: AppConfig): AppServices {
  if (config.databaseUrl === 'memory:') return createMemoryServices(config)
  const pool = createDatabasePool(config)
  const runStore = new PostgresRunStore(pool)
  const credentialVault = new PostgresCredentialVault(pool, config.credentialMasterKey)
  const publicRepository = new PostgresPublicRepository(pool, config.scoringReleaseId)
  const contributionStore = new PostgresContributionStore(pool)
  return {
    runStore,
    credentialVault,
    publicRepository,
    contributionStore,
    async close() {
      await pool.end()
    },
  }
}
