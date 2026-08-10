import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Value } from '@sinclair/typebox/value'
import {
  DONATION_DISCLOSURE_VERSION,
  DonationConstraintsSchema,
  type DonationConstraints,
} from '../contracts/contributions.js'
import { AppError } from '../errors.js'

export interface DonationQuote {
  quoteId: string
  kind: 'api'
  targetOrigin: string
  targetBaseUrl: string
  targetHostname: string
  constraints: DonationConstraints
  disclosureVersion: typeof DONATION_DISCLOSURE_VERSION
  issuedAt: string
  expiresAt: string
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update('model-observatory:donation-quote:').update(payload).digest()
}

export function issueDonationQuote(
  value: Pick<DonationQuote, 'kind' | 'targetOrigin' | 'targetBaseUrl' | 'targetHostname' | 'constraints'>,
  secret: string,
  ttlSeconds: number,
  now = new Date(),
): { quote: DonationQuote; token: string } {
  const quote: DonationQuote = {
    ...value,
    quoteId: randomUUID(),
    disclosureVersion: DONATION_DISCLOSURE_VERSION,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  }
  const payload = Buffer.from(JSON.stringify(quote)).toString('base64url')
  return { quote, token: `${payload}.${signature(payload, secret).toString('base64url')}` }
}

export function verifyDonationQuote(token: string, secret: string, now = new Date()): DonationQuote {
  const [payload, encodedSignature, extra] = token.split('.')
  if (!payload || !encodedSignature || extra) throw new AppError(400, 'invalid_donation_quote', 'The donation quote is invalid.')
  const observed = Buffer.from(encodedSignature, 'base64url')
  const expected = signature(payload, secret)
  if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) {
    throw new AppError(400, 'invalid_donation_quote', 'The donation quote is invalid.')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new AppError(400, 'invalid_donation_quote', 'The donation quote payload is invalid.')
  }
  if (!value || typeof value !== 'object') throw new AppError(400, 'invalid_donation_quote', 'The donation quote payload is invalid.')
  const quote = value as Partial<DonationQuote>
  if (
    typeof quote.quoteId !== 'string' || quote.kind !== 'api' || typeof quote.targetOrigin !== 'string' ||
    typeof quote.targetBaseUrl !== 'string' || typeof quote.targetHostname !== 'string' || typeof quote.expiresAt !== 'string' ||
    quote.disclosureVersion !== DONATION_DISCLOSURE_VERSION || !Value.Check(DonationConstraintsSchema, quote.constraints)
  ) {
    throw new AppError(400, 'invalid_donation_quote', 'The donation quote payload is incomplete.')
  }
  if (new Date(quote.expiresAt).getTime() <= now.getTime()) throw new AppError(410, 'donation_quote_expired', 'The donation quote has expired.')
  return quote as DonationQuote
}
