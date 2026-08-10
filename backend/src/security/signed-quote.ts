import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Value } from '@sinclair/typebox/value'
import type { RunConfig, RunEstimate } from '../contracts/private-runs.js'
import { RunConfigSchema } from '../contracts/private-runs.js'
import { DISCLOSURE_VERSION } from '../contracts/common.js'
import { AppError } from '../errors.js'

export interface RunQuote {
  quoteId: string
  targetOrigin: string
  targetBaseUrl: string
  targetHostname: string
  model: string
  config: RunConfig
  estimate: RunEstimate
  disclosureVersion: typeof DISCLOSURE_VERSION
  scoringReleaseId: string
  issuedAt: string
  expiresAt: string
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update('model-observatory:run-quote:').update(payload).digest()
}

export function issueQuote(
  value: Omit<RunQuote, 'quoteId' | 'issuedAt' | 'expiresAt' | 'disclosureVersion'>,
  secret: string,
  ttlSeconds: number,
  now = new Date(),
): { quote: RunQuote; token: string } {
  const quote: RunQuote = {
    ...value,
    quoteId: randomUUID(),
    disclosureVersion: DISCLOSURE_VERSION,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  }
  const payload = Buffer.from(JSON.stringify(quote)).toString('base64url')
  return { quote, token: `${payload}.${signature(payload, secret).toString('base64url')}` }
}

export function verifyQuote(token: string, secret: string, now = new Date()): RunQuote {
  const [payload, encodedSignature, extra] = token.split('.')
  if (!payload || !encodedSignature || extra) throw new AppError(400, 'invalid_quote', 'The quote token is invalid.')
  const observed = Buffer.from(encodedSignature, 'base64url')
  const expected = signature(payload, secret)
  if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) {
    throw new AppError(400, 'invalid_quote', 'The quote token is invalid.')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new AppError(400, 'invalid_quote', 'The quote payload is invalid.')
  }
  if (value == null || typeof value !== 'object') throw new AppError(400, 'invalid_quote', 'The quote payload is invalid.')
  const quote = value as Partial<RunQuote>
  if (
    typeof quote.quoteId !== 'string' ||
    typeof quote.targetOrigin !== 'string' ||
    typeof quote.targetBaseUrl !== 'string' ||
    typeof quote.targetHostname !== 'string' ||
    typeof quote.model !== 'string' ||
    typeof quote.expiresAt !== 'string' ||
    typeof quote.scoringReleaseId !== 'string' ||
    quote.disclosureVersion !== DISCLOSURE_VERSION ||
    !Value.Check(RunConfigSchema, quote.config)
  ) {
    throw new AppError(400, 'invalid_quote', 'The quote payload is incomplete.')
  }
  if (new Date(quote.expiresAt).getTime() <= now.getTime()) throw new AppError(410, 'quote_expired', 'The quote has expired.')
  return quote as RunQuote
}
