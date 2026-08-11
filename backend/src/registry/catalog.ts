import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { domainToASCII } from 'node:url'
import { AppError } from '../errors.js'

export const SCORED_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const

export interface RegistryDomain {
  hostname: string
  role: 'primary' | 'alias'
  default_base_path: string
  status: 'active' | 'retired'
}

export interface RegistryGroup {
  id: string
  name: string
  aliases: string[]
  multiplier: number
  models: string[]
}

export interface RegistryProvider {
  slug: string
  name: string
  kind: 'relay' | 'official' | 'official_proxy'
  domains: RegistryDomain[]
  group_detection: { probe_model: string }
  groups: RegistryGroup[]
}

export interface ProviderRegistryDocument {
  schema_version: 2
  pricing: { input_per_million_usd: number; output_per_million_usd: number }
  providers: RegistryProvider[]
}

export interface ProviderRegistry {
  document: ProviderRegistryDocument
  contentSha256: string
  findByHostname(hostname: string): RegistryProvider | null
  findActiveByHostname(hostname: string): RegistryProvider | null
  findGroup(providerSlug: string, groupId: string): RegistryGroup | null
}

export const EMPTY_PROVIDER_REGISTRY = createProviderRegistry({
  schema_version: 2,
  pricing: { input_per_million_usd: 1.25, output_per_million_usd: 10 },
  providers: [],
})

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) throw new Error(`${label} is invalid`)
  return value.trim()
}

function hostname(value: unknown, label: string): string {
  const input = text(value, label).toLowerCase().replace(/\.$/, '')
  const ascii = domainToASCII(input)
  if (!ascii || ascii.includes('/') || ascii.includes(':') || ascii.includes('*')) throw new Error(`${label} must be a hostname`)
  return ascii
}

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`)
  return value
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map((item, index) => text(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`)
  return result
}

export function parseProviderRegistry(value: unknown): ProviderRegistryDocument {
  const root = object(value, 'registry')
  if (root['schema_version'] !== 2) throw new Error('registry.schema_version must be 2')
  const pricingValue = object(root['pricing'], 'registry.pricing')
  const pricing = {
    input_per_million_usd: finitePositive(pricingValue['input_per_million_usd'], 'registry.pricing.input_per_million_usd'),
    output_per_million_usd: finitePositive(pricingValue['output_per_million_usd'], 'registry.pricing.output_per_million_usd'),
  }
  if (!Array.isArray(root['providers'])) throw new Error('registry.providers must be an array')
  const providerIds = new Set<string>()
  const hostnames = new Set<string>()
  const providers = root['providers'].map((rawProvider, providerIndex): RegistryProvider => {
    const item = object(rawProvider, `providers[${providerIndex}]`)
    const slug = text(item['slug'], `providers[${providerIndex}].slug`, /^[a-z0-9][a-z0-9-]{0,127}$/)
    if (providerIds.has(slug)) throw new Error(`provider slug ${slug} is duplicated`)
    providerIds.add(slug)
    const kind = item['kind']
    if (kind !== 'relay' && kind !== 'official' && kind !== 'official_proxy') throw new Error(`provider ${slug} has an invalid kind`)
    if (!Array.isArray(item['domains']) || item['domains'].length === 0) throw new Error(`provider ${slug} must have domains`)
    let primary = 0
    const domains = item['domains'].map((rawDomain, domainIndex): RegistryDomain => {
      const domain = object(rawDomain, `${slug}.domains[${domainIndex}]`)
      const normalized = hostname(domain['hostname'], `${slug}.domains[${domainIndex}].hostname`)
      if (hostnames.has(normalized)) throw new Error(`hostname ${normalized} is assigned more than once`)
      hostnames.add(normalized)
      const role = domain['role']
      if (role !== 'primary' && role !== 'alias') throw new Error(`domain ${normalized} has an invalid role`)
      if (role === 'primary') primary += 1
      const status = domain['status']
      if (status !== 'active' && status !== 'retired') throw new Error(`domain ${normalized} has an invalid status`)
      const basePath = text(domain['default_base_path'], `${normalized}.default_base_path`)
      if (!basePath.startsWith('/') || basePath.includes('?') || basePath.includes('#')) throw new Error(`domain ${normalized} has an invalid default_base_path`)
      return { hostname: normalized, role, status, default_base_path: basePath.replace(/\/+$/, '') || '/' }
    })
    if (primary !== 1) throw new Error(`provider ${slug} must have exactly one primary domain`)
    const detection = object(item['group_detection'], `${slug}.group_detection`)
    const groupDetection = { probe_model: text(detection['probe_model'], `${slug}.group_detection.probe_model`) }
    if (!Array.isArray(item['groups'])) throw new Error(`provider ${slug}.groups must be an array`)
    const groupIds = new Set<string>()
    const groups = item['groups'].map((rawGroup, groupIndex): RegistryGroup => {
      const group = object(rawGroup, `${slug}.groups[${groupIndex}]`)
      const id = text(group['id'], `${slug}.groups[${groupIndex}].id`, /^[a-z0-9][a-z0-9_-]{0,127}$/)
      if (groupIds.has(id)) throw new Error(`provider ${slug} group ${id} is duplicated`)
      groupIds.add(id)
      const models = stringList(group['models'], `${slug}.${id}.models`)
      if (models.length === 0) throw new Error(`provider ${slug} group ${id} must contain models`)
      for (const model of models) if (!(SCORED_MODELS as readonly string[]).includes(model)) throw new Error(`model ${model} is not supported by the scoring release`)
      return {
        id,
        name: text(group['name'], `${slug}.${id}.name`),
        aliases: stringList(group['aliases'] ?? [], `${slug}.${id}.aliases`),
        multiplier: finitePositive(group['multiplier'], `${slug}.${id}.multiplier`),
        models,
      }
    })
    return { slug, name: text(item['name'], `${slug}.name`), kind, domains, group_detection: groupDetection, groups }
  })
  return { schema_version: 2, pricing, providers }
}

export function createProviderRegistry(document: ProviderRegistryDocument): ProviderRegistry {
  const byHostname = new Map<string, RegistryProvider>()
  const activeByHostname = new Map<string, RegistryProvider>()
  for (const provider of document.providers) {
    for (const domain of provider.domains) {
      byHostname.set(domain.hostname, provider)
      if (domain.status === 'active') activeByHostname.set(domain.hostname, provider)
    }
  }
  return {
    document,
    contentSha256: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    findByHostname(value) { return byHostname.get(hostname(value, 'hostname')) ?? null },
    findActiveByHostname(value) { return activeByHostname.get(hostname(value, 'hostname')) ?? null },
    findGroup(providerSlug, groupId) { return document.providers.find((item) => item.slug === providerSlug)?.groups.find((item) => item.id === groupId) ?? null },
  }
}

export async function loadProviderRegistry(path: string): Promise<ProviderRegistry> {
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch { throw new AppError(500, 'provider_registry_unavailable', `Provider registry could not be read from ${path}.`) }
  try { return createProviderRegistry(parseProviderRegistry(JSON.parse(raw) as unknown)) } catch (error) {
    throw new AppError(500, 'provider_registry_invalid', error instanceof Error ? error.message : 'Provider registry is invalid.')
  }
}
