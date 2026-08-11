import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'

export type AppEnvironment = 'development' | 'test' | 'production'

export interface AppConfig {
  appEnv: AppEnvironment
  host: string
  port: number
  publicOrigin: string
  databaseUrl: string
  databaseSsl: boolean
  logLevel: string
  enableApiDocs: boolean
  tokenPepper: string
  quoteSigningSecret: string
  credentialMasterKey: Buffer
  quoteTtlSeconds: number
  runRetentionHours: number
  maxRunRequests: number
  scoringReleaseId: string
  repositoryUrl: string
  trustProxy: false | string | string[] | number
  frontendDistDir: string | null
  providerRegistryPath: string
}

function parseEnvironment(value: string | undefined): AppEnvironment {
  if (value === 'production' || value === 'test') return value
  return 'development'
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }
  return port
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return value === 'true' || value === '1'
}

function secret(value: string | undefined, name: string, environment: AppEnvironment): string {
  if (value && value.length >= 32) return value
  if (environment === 'production') throw new Error(`${name} must contain at least 32 characters`)
  return randomBytes(32).toString('base64url')
}

function masterKey(value: string | undefined, environment: AppEnvironment): Buffer {
  if (value) {
    const decoded = Buffer.from(value, 'base64')
    if (decoded.length === 32) return decoded
  }
  if (environment === 'production') {
    throw new Error('CREDENTIAL_MASTER_KEY must be a base64-encoded 32-byte value')
  }
  return randomBytes(32)
}

function repositoryUrl(value: string | undefined): string {
  const url = new URL(value ?? 'https://github.com/OWNER/REPO')
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('REPOSITORY_URL must be an HTTPS github.com repository URL')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2) throw new Error('REPOSITORY_URL must identify one GitHub owner and repository')
  return `${url.origin}/${parts.join('/')}`
}

function validTrustedAddress(item: string): boolean {
  const [address, prefix, extra] = item.split('/')
  const family = isIP(address ?? '')
  if (!family || extra != null) return false
  if (prefix == null) return true
  if (!/^\d+$/.test(prefix)) return false
  const bits = Number(prefix)
  return bits >= 0 && bits <= (family === 4 ? 32 : 128)
}

function trustProxy(value: string | undefined): AppConfig['trustProxy'] {
  if (!value) return false
  if (/^\d+$/.test(value)) {
    const hops = Number(value)
    if (hops < 1 || hops > 10) throw new Error('TRUST_PROXY hop count must be between 1 and 10')
    return hops
  }
  const addresses = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (!addresses.length || addresses.some((item) => !validTrustedAddress(item))) {
    throw new Error('TRUST_PROXY must contain IP/CIDR values or a trusted hop count')
  }
  return addresses.length === 1 ? addresses[0]! : addresses
}

function frontendDistDir(value: string | undefined): string | null {
  if (!value) return null
  if (!isAbsolute(value)) throw new Error('FRONTEND_DIST_DIR must be an absolute path')
  return value
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const appEnv = parseEnvironment(environment['APP_ENV'] ?? environment['NODE_ENV'])
  const publicOrigin = environment['PUBLIC_ORIGIN'] ?? 'http://localhost:5173'
  const origin = new URL(publicOrigin)
  if (!['http:', 'https:'].includes(origin.protocol)) {
    throw new Error('PUBLIC_ORIGIN must use http or https')
  }

  return {
    appEnv,
    host: environment['HOST'] ?? '127.0.0.1',
    port: parsePort(environment['PORT']),
    publicOrigin: origin.origin,
    databaseUrl: environment['DATABASE_URL'] ?? 'memory:',
    databaseSsl: parseBoolean(environment['DATABASE_SSL'], appEnv === 'production'),
    logLevel: environment['LOG_LEVEL'] ?? 'info',
    enableApiDocs: parseBoolean(environment['ENABLE_API_DOCS'], appEnv !== 'production'),
    tokenPepper: secret(environment['TOKEN_PEPPER'], 'TOKEN_PEPPER', appEnv),
    quoteSigningSecret: secret(environment['QUOTE_SIGNING_SECRET'], 'QUOTE_SIGNING_SECRET', appEnv),
    credentialMasterKey: masterKey(environment['CREDENTIAL_MASTER_KEY'], appEnv),
    quoteTtlSeconds: 10 * 60,
    runRetentionHours: 24,
    maxRunRequests: 500,
    scoringReleaseId: environment['SCORING_RELEASE_ID'] ?? 'stage-c-trusted-fingerprint-v4',
    repositoryUrl: repositoryUrl(environment['REPOSITORY_URL']),
    trustProxy: trustProxy(environment['TRUST_PROXY']),
    frontendDistDir: frontendDistDir(environment['FRONTEND_DIST_DIR']),
    providerRegistryPath: environment['PROVIDER_REGISTRY_PATH'] ?? '../registry/providers.json',
  }
}
