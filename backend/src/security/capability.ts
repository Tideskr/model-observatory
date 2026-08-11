import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type CapabilityKind = 'run-owner' | 'donation-revocation' | 'worker-lease'

export interface IssuedCapability {
  token: string
  hash: string
  tail: string
}

export function hashCapability(token: string, kind: CapabilityKind, pepper: string): string {
  return createHmac('sha256', pepper).update(`model-observatory:${kind}:`).update(token).digest('hex')
}

export function issueCapability(kind: CapabilityKind, pepper: string): IssuedCapability {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    hash: hashCapability(token, kind, pepper),
    tail: token.slice(-6),
  }
}

export function deriveRunOwnerCapability(runId: string, idempotencyKey: string, pepper: string): IssuedCapability {
  const token = createHmac('sha256', pepper)
    .update('model-observatory:run-owner-token:')
    .update(runId)
    .update(':')
    .update(idempotencyKey)
    .digest('base64url')
  return { token, hash: hashCapability(token, 'run-owner', pepper), tail: token.slice(-6) }
}

export function deriveDonationRevocationCapability(
  donationId: string,
  idempotencyKey: string,
  pepper: string,
): IssuedCapability {
  const token = createHmac('sha256', pepper)
    .update('model-observatory:donation-revocation-token:')
    .update(donationId)
    .update(':')
    .update(idempotencyKey)
    .digest('base64url')
  return { token, hash: hashCapability(token, 'donation-revocation', pepper), tail: token.slice(-6) }
}

export function verifyCapability(
  token: string,
  expectedHash: string,
  kind: CapabilityKind,
  pepper: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false
  const observed = Buffer.from(hashCapability(token, kind, pepper), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return observed.length === expected.length && timingSafeEqual(observed, expected)
}
