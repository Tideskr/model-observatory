import type { DatabasePool } from '../db/connection.js'
import type { ProviderRegistry } from './catalog.js'

export async function syncProviderRegistry(pool: DatabasePool, registry: ProviderRegistry): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE providers SET active=false')
    await client.query('UPDATE provider_groups SET active=false')
    await client.query('UPDATE provider_models SET active=false')
    await client.query('DELETE FROM provider_domains')
    for (const provider of registry.document.providers) {
      const primary = provider.domains.find((item) => item.role === 'primary')!
      await client.query(
        `INSERT INTO providers(slug,name,kind,endpoint_hostname,last_checked_at,active)
         VALUES ($1,$2,$3,$4,NULL,true)
         ON CONFLICT (slug) DO UPDATE SET name=excluded.name,kind=excluded.kind,
           endpoint_hostname=excluded.endpoint_hostname,active=true,updated_at=now()`,
        [provider.slug, provider.name, provider.kind, primary.hostname],
      )
      for (const domain of provider.domains) {
        await client.query(
          `INSERT INTO provider_domains(hostname,provider_slug,role,default_base_path,status)
           VALUES ($1,$2,$3,$4,$5)`,
          [domain.hostname, provider.slug, domain.role, domain.default_base_path, domain.status],
        )
      }
      for (const group of provider.groups) {
        await client.query(
          `INSERT INTO provider_groups(provider_slug,group_id,kind,label,multiplier,active)
           VALUES ($1,$2,'price',$3,$4,true)
           ON CONFLICT (provider_slug,group_id) DO UPDATE SET kind='price',label=excluded.label,
             multiplier=excluded.multiplier,active=true`,
          [provider.slug, group.id, group.name, group.multiplier],
        )
        for (const model of group.models) {
          await client.query(
            `INSERT INTO provider_models(provider_slug,group_id,model,active) VALUES ($1,$2,$3,true)
             ON CONFLICT (provider_slug,group_id,model) DO UPDATE SET active=true`,
            [provider.slug, group.id, model],
          )
        }
      }
    }
    await client.query(
      `INSERT INTO provider_registry_versions(content_sha256,schema_version) VALUES ($1,$2)
       ON CONFLICT (content_sha256) DO NOTHING`,
      [registry.contentSha256, registry.document.schema_version],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
