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
import { EMPTY_PROVIDER_REGISTRY, type ProviderRegistry } from './registry/catalog.js'
import { loadActiveProviderRegistry, ProviderRegistryReloader, ReloadableProviderRegistry, type RegistryLogger } from './registry/runtime.js'
import { AdminService } from './admin/service.js'
import { loadScoringRelease } from './scoring/repository.js'
import type { ScoringReleaseSeed } from './scoring/types.js'

export interface AppServices {
  runStore: RunStore
  credentialVault: CredentialVault
  publicRepository: PublicRepository
  contributionStore: ContributionStore
  providerRegistry: ProviderRegistry
  adminService: AdminService | null
  loadScoringRelease(releaseId: string): Promise<ScoringReleaseSeed>
  close(): Promise<void>
}

export function createMemoryServices(config: AppConfig, providerRegistry: ProviderRegistry = EMPTY_PROVIDER_REGISTRY): AppServices {
  const runStore = new MemoryRunStore()
  const credentialVault = new MemoryCredentialVault(config.credentialMasterKey)
  const publicRepository = new MemoryPublicRepository([], config.scoringReleaseId)
  const contributionStore = new MemoryContributionStore()
  return {
    runStore,
    credentialVault,
    publicRepository,
    contributionStore,
    providerRegistry,
    adminService: null,
    async loadScoringRelease() { throw new Error('Scoring releases are not stored in memory services.') },
    async close() {
      await Promise.all([runStore.close(), credentialVault.close(), contributionStore.close()])
    },
  }
}

export async function createServices(
  config: AppConfig,
  providerRegistry: ProviderRegistry = EMPTY_PROVIDER_REGISTRY,
  logger: RegistryLogger = console,
): Promise<AppServices> {
  if (config.databaseUrl === 'memory:') return createMemoryServices(config, providerRegistry)
  const pool = createDatabasePool(config)
  let reloader: ProviderRegistryReloader | null = null
  let runtime: ReloadableProviderRegistry
  try {
    runtime = new ReloadableProviderRegistry(await loadActiveProviderRegistry(pool))
    reloader = new ProviderRegistryReloader(pool, runtime, logger)
    await reloader.start()
  } catch (error) {
    await pool.end()
    throw error
  }
  const runStore = new PostgresRunStore(pool)
  const credentialVault = new PostgresCredentialVault(pool, config.credentialMasterKey)
  const publicRepository = new PostgresPublicRepository(pool, config.scoringReleaseId)
  const contributionStore = new PostgresContributionStore(pool)
  const adminService = config.githubAdmin ? new AdminService(config.githubAdmin, pool, runtime) : null
  return {
    runStore,
    credentialVault,
    publicRepository,
    contributionStore,
    providerRegistry: runtime,
    adminService,
    loadScoringRelease: (releaseId) => loadScoringRelease(pool, releaseId),
    async close() {
      await reloader?.close()
      await pool.end()
    },
  }
}
