import type { PoolClient } from 'pg'
import type { DatabasePool } from '../db/connection.js'
import { createProviderRegistry, parseProviderRegistry, type ProviderRegistry, type ProviderRegistryDocument, type RegistryProvider } from './catalog.js'

export interface RegistryLogger {
  info(values: Record<string, unknown>, message: string): void
  warn(values: Record<string, unknown>, message: string): void
  error(values: Record<string, unknown>, message: string): void
}

export class ReloadableProviderRegistry implements ProviderRegistry {
  #current: ProviderRegistry

  constructor(initial: ProviderRegistry) {
    this.#current = initial.snapshot()
  }

  get document(): ProviderRegistryDocument { return this.#current.document }
  get contentSha256(): string { return this.#current.contentSha256 }
  findByHostname(hostname: string): RegistryProvider | null { return this.#current.findByHostname(hostname) }
  findActiveByHostname(hostname: string): RegistryProvider | null { return this.#current.findActiveByHostname(hostname) }
  findGroup(providerSlug: string, groupId: string) { return this.#current.findGroup(providerSlug, groupId) }
  snapshot(): ProviderRegistry { return this.#current }

  replace(next: ProviderRegistry): boolean {
    if (next.contentSha256 === this.#current.contentSha256) return false
    this.#current = next.snapshot()
    return true
  }
}

export async function loadActiveProviderRegistry(pool: DatabasePool): Promise<ProviderRegistry> {
  const result = await pool.query<{ content_sha256: string; document: unknown }>(
    'SELECT content_sha256,document FROM provider_registry_state WHERE singleton=true',
  )
  const row = result.rows[0]
  if (!row) throw new Error('The active provider registry has not been initialized.')
  const registry = createProviderRegistry(parseProviderRegistry(row.document))
  if (registry.contentSha256 !== row.content_sha256) throw new Error('The active provider registry hash does not match its document.')
  return registry
}

export class ProviderRegistryReloader {
  #listener: PoolClient | null = null
  #poll: NodeJS.Timeout | null = null
  #retry: NodeJS.Timeout | null = null
  #closed = false
  #refreshing: Promise<void> | null = null

  constructor(
    private readonly pool: DatabasePool,
    private readonly registry: ReloadableProviderRegistry,
    private readonly logger: RegistryLogger,
  ) {}

  async start(): Promise<void> {
    await this.#refresh()
    await this.#listen()
    this.#poll = setInterval(() => void this.#refresh(), 30_000)
    this.#poll.unref()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#poll) clearInterval(this.#poll)
    if (this.#retry) clearTimeout(this.#retry)
    const listener = this.#listener
    this.#listener = null
    if (listener) {
      listener.removeAllListeners('notification')
      listener.removeAllListeners('error')
      try { await listener.query('UNLISTEN provider_registry_updated') } catch { /* Pool shutdown may already be in progress. */ }
      listener.release()
    }
    await this.#refreshing
  }

  async #listen(): Promise<void> {
    if (this.#closed || this.#listener) return
    let client: PoolClient | null = null
    try {
      const connected = await this.pool.connect()
      client = connected
      if (this.#closed) { connected.release(); return }
      await connected.query('LISTEN provider_registry_updated')
      connected.on('notification', (message) => {
        if (message.channel === 'provider_registry_updated') void this.#refresh(message.payload)
      })
      connected.on('error', (error) => {
        this.logger.error({ err: error }, 'provider registry listener failed')
        if (this.#listener === connected) this.#listener = null
        connected.release(true)
        this.#scheduleReconnect()
      })
      this.#listener = connected
    } catch (error) {
      client?.release(true)
      this.logger.error({ err: error }, 'provider registry listener could not connect')
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#retry) return
    this.#retry = setTimeout(() => {
      this.#retry = null
      void this.#listen()
    }, 1_000)
    this.#retry.unref()
  }

  async #refresh(expectedSha?: string): Promise<void> {
    if (this.#closed) return
    if (this.#refreshing) return this.#refreshing
    this.#refreshing = (async () => {
      try {
        const next = await loadActiveProviderRegistry(this.pool)
        if (expectedSha && next.contentSha256 !== expectedSha) {
          this.logger.warn({ expectedSha, actualSha: next.contentSha256 }, 'provider registry notification was superseded')
        }
        if (this.registry.replace(next)) {
          this.logger.info({ registrySha256: next.contentSha256 }, 'provider registry hot reloaded')
        }
      } catch (error) {
        this.logger.error({ err: error }, 'provider registry refresh failed; retaining the previous snapshot')
      }
    })().finally(() => { this.#refreshing = null })
    return this.#refreshing
  }
}
