import type { DatabasePool } from '../db/connection.js'
import type { PublicProvider, PublicRegistryItem } from '../contracts/public.js'
import type { PublicRepository } from './public-repository.js'

export class PostgresPublicRepository implements PublicRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly scoringReleaseId: string,
  ) {}

  async listProviders(): Promise<PublicProvider[]> {
    const providers = await this.pool.query<{ slug: string; name: string; kind: PublicProvider['kind']; endpoint_hostname: string; last_checked_at: Date | null }>(
      `SELECT p.slug,p.name,p.kind,p.endpoint_hostname,p.last_checked_at FROM providers p
       WHERE p.active=true AND EXISTS (SELECT 1 FROM provider_groups g WHERE g.provider_slug=p.slug AND g.active=true)
       ORDER BY p.name`,
    )
    return Promise.all(providers.rows.map((row) => this.#hydrateProvider(row)))
  }

  async getProvider(slug: string): Promise<PublicProvider | null> {
    const result = await this.pool.query<{ slug: string; name: string; kind: PublicProvider['kind']; endpoint_hostname: string; last_checked_at: Date | null }>(
      'SELECT slug,name,kind,endpoint_hostname,last_checked_at FROM providers WHERE slug=$1 AND active=true', [slug],
    )
    return result.rows[0] ? this.#hydrateProvider(result.rows[0]) : null
  }

  async listRegistry(status: 'stable' | 'beta'): Promise<{ releaseId: string; items: PublicRegistryItem[] }> {
    if (status === 'beta') return { releaseId: this.scoringReleaseId, items: [] }
    const result = await this.pool.query<{
      probe_id: string; category: string; prompt: string; prompt_sha256: string; developer_prompt: string;
      scoring_kind: string; prompt_rewrite_allowed: boolean; metadata: Record<string, unknown>
    }>(
      `SELECT probe_id,category,prompt,prompt_sha256,developer_prompt,scoring_kind,prompt_rewrite_allowed,metadata
       FROM scoring_probes WHERE release_id=$1 ORDER BY probe_id`, [this.scoringReleaseId],
    )
    return {
      releaseId: this.scoringReleaseId,
      items: result.rows.map((row) => ({
        id: row.probe_id, category: row.category, prompt_template: row.prompt, prompt_sha256: row.prompt_sha256,
        ...(row.developer_prompt ? { developer_message: row.developer_prompt } : {}),
        scoring_kind: row.scoring_kind, prompt_rewrite_allowed: row.prompt_rewrite_allowed,
        status: 'stable' as const, metadata: row.metadata,
      })),
    }
  }

  async #hydrateProvider(row: { slug: string; name: string; kind: PublicProvider['kind']; endpoint_hostname: string; last_checked_at: Date | null }): Promise<PublicProvider> {
    const [domains, groups, models, scores, history, anomalies] = await Promise.all([
      this.pool.query<{ hostname: string }>('SELECT hostname FROM provider_domains WHERE provider_slug=$1 ORDER BY role DESC,hostname', [row.slug]),
      this.pool.query<{ group_id: string; kind: 'none' | 'price' | 'tier'; label: string; multiplier: number | null }>('SELECT group_id,kind,label,multiplier FROM provider_groups WHERE provider_slug=$1 AND active=true ORDER BY group_id', [row.slug]),
      this.pool.query<{ group_id: string; model: string }>('SELECT group_id,model FROM provider_models WHERE provider_slug=$1 AND active=true ORDER BY group_id,model', [row.slug]),
      this.pool.query<{ group_id: string; model: string; source: 'vendor' | 'donated' | 'community'; confidence: number | null; samples: number; availability: number | null; attempted_samples: number; inconclusive_samples: number; verified_samples: number; declared_samples: number }>('SELECT group_id,model,source,confidence,samples,availability,attempted_samples,inconclusive_samples,verified_samples,declared_samples FROM provider_source_scores WHERE provider_slug=$1', [row.slug]),
      this.pool.query<{ confidence: number }>(
        `SELECT confidence FROM (SELECT bucket_at,confidence FROM provider_history WHERE provider_slug=$1
         ORDER BY bucket_at DESC LIMIT 30) recent ORDER BY bucket_at`, [row.slug],
      ),
      this.pool.query<{ id: string; observed_at: Date; channel_display: string; source: 'vendor' | 'donated' | 'community'; model: string; group_id: string | null; probe_id: string; expected_display: string; observed_display: string; severity: 'hard' | 'soft' }>('SELECT id,observed_at,channel_display,source,model,group_id,probe_id,expected_display,observed_display,severity FROM public_anomalies WHERE provider_slug=$1 ORDER BY observed_at DESC', [row.slug]),
    ])
    return {
      slug: row.slug, name: row.name, kind: row.kind, endpoint: row.endpoint_hostname,
      domains: domains.rows.map((item) => item.hostname),
      lastCheckedAt: row.last_checked_at?.toISOString() ?? null, history: history.rows.map((item) => item.confidence),
      groups: groups.rows.map((group) => ({
        id: group.group_id, kind: group.kind, label: group.label,
        ...(group.multiplier == null ? {} : { multiplier: group.multiplier }),
        models: models.rows.filter((item) => item.group_id === group.group_id).map((item) => {
          const values = scores.rows.filter((score) => score.group_id === group.group_id && score.model === item.model)
          const bySource = { vendor: null, donated: null, community: null } as Record<'vendor' | 'donated' | 'community', number | null>
          const samples = { vendor: 0, donated: 0, community: 0 }
          const availabilityBySource = { vendor: null, donated: null, community: null } as Record<'vendor' | 'donated' | 'community', number | null>
          const attemptedSamples = { vendor: 0, donated: 0, community: 0 }
          const inconclusiveSamples = { vendor: 0, donated: 0, community: 0 }
          const attribution = { verified: 0, donor_declared: 0 }
          for (const score of values) {
            bySource[score.source] = score.confidence; samples[score.source] = score.samples
            availabilityBySource[score.source] = score.availability; attemptedSamples[score.source] = score.attempted_samples
            inconclusiveSamples[score.source] = score.inconclusive_samples
            if (score.source === 'donated') { attribution.verified = score.verified_samples; attribution.donor_declared = score.declared_samples }
          }
          return { model: item.model, bySource, samples, availabilityBySource, attemptedSamples, inconclusiveSamples, attribution }
        }),
      })),
      anomalies: anomalies.rows.map((item) => ({
        id: item.id, at: item.observed_at.toISOString(), channel: item.channel_display, source: item.source,
        model: item.model, ...(item.group_id ? { groupId: item.group_id } : {}), probeId: item.probe_id,
        expected: item.expected_display, observed: item.observed_display, severity: item.severity,
      })),
    }
  }
}
