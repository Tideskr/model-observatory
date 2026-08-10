import type { PublicProvider, PublicRegistryItem } from '../contracts/public.js'

export interface PublicRepository {
  listProviders(): Promise<PublicProvider[]>
  getProvider(slug: string): Promise<PublicProvider | null>
  listRegistry(status: 'stable' | 'beta'): Promise<{ releaseId: string; items: PublicRegistryItem[] }>
}

export class MemoryPublicRepository implements PublicRepository {
  constructor(
    private readonly providers: PublicProvider[] = [],
    private readonly releaseId = 'stage-c-trusted-likelihood-v2',
    private readonly registry: PublicRegistryItem[] = [],
  ) {}

  async listProviders(): Promise<PublicProvider[]> {
    return structuredClone(this.providers)
  }

  async getProvider(slug: string): Promise<PublicProvider | null> {
    const provider = this.providers.find((item) => item.slug === slug)
    return provider ? structuredClone(provider) : null
  }

  async listRegistry(status: 'stable' | 'beta'): Promise<{ releaseId: string; items: PublicRegistryItem[] }> {
    return { releaseId: this.releaseId, items: structuredClone(this.registry.filter((item) => item.status === status)) }
  }
}
