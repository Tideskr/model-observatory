import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { assertRunTransition, canTransitionRun } from '../src/domain/run-state.js'
import { estimateRun } from '../src/domain/run-estimate.js'
import { AppError } from '../src/errors.js'
import { chainAuditEvent } from '../src/security/audit-chain.js'
import { issueCapability, verifyCapability } from '../src/security/capability.js'
import { MemoryCredentialVault } from '../src/security/credential-vault.js'

test('run state machine accepts only declared transitions', () => {
  assert.equal(canTransitionRun('queued', 'provisioning'), true)
  assert.equal(canTransitionRun('running', 'completed'), false)
  assert.equal(canTransitionRun('scoring', 'timed_out'), true)
  assert.equal(canTransitionRun('scoring', 'cancelled'), true)
  assert.throws(() => assertRunTransition('completed', 'running'), AppError)
})

test('run estimates include retries in maximum attempts and cost', () => {
  const config = {
    probes: [{ probe_id: 'juice_high' as const, requests: 2 }],
    formats: ['normal'] as ['normal'], contexts: ['no_history'] as ['no_history'], workers: 1, retries: 3,
  }
  const estimate = estimateRun(config, 1, 8)
  assert.equal(estimate.requests, 2)
  assert.equal(estimate.maximum_attempts, 8)
  assert.equal(estimate.maximum_input_tokens, estimate.input_tokens * 4)
  assert.equal(estimate.maximum_output_tokens, 2 * 4 * 2_048)
  assert.throws(() => estimateRun(config, 1, 7), AppError)
})

test('trusted proxy configuration is explicit and bounded', () => {
  const base = {
    APP_ENV: 'test', TOKEN_PEPPER: 'p'.repeat(32), QUOTE_SIGNING_SECRET: 'q'.repeat(32),
    CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 2).toString('base64'),
  }
  assert.equal(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy, 1)
  assert.deepEqual(loadConfig({ ...base, TRUST_PROXY: '127.0.0.1,::1' }).trustProxy, ['127.0.0.1', '::1'])
  assert.throws(() => loadConfig({ ...base, TRUST_PROXY: 'true' }))
  assert.throws(() => loadConfig({ ...base, TRUST_PROXY: '999.999.999.999' }))
  assert.throws(() => loadConfig({ ...base, TRUST_PROXY: '2001:db8::/129' }))
})

test('credential vault purges expired encrypted envelopes', async () => {
  const vault = new MemoryCredentialVault(Buffer.alloc(32, 5))
  const handle = await vault.put('temporary-secret', 'test', new Date(Date.now() - 1))
  assert.equal(vault.size, 1)
  assert.equal(await vault.purgeExpired(), 1)
  assert.equal(vault.size, 0)
  await assert.rejects(() => vault.read(handle))
})

test('capability tokens are domain-separated and verifiable', () => {
  const pepper = 'p'.repeat(32)
  const capability = issueCapability('run-owner', pepper)
  assert.equal(verifyCapability(capability.token, capability.hash, 'run-owner', pepper), true)
  assert.equal(verifyCapability(capability.token, capability.hash, 'donation-revocation', pepper), false)
  assert.equal(capability.tail.length, 6)
})

test('audit events form a deterministic tamper-evident chain', () => {
  const input = {
    action: 'run.created',
    subjectType: 'private_run',
    subjectId: 'run-1',
    actorType: 'capability',
    payload: { model: 'gpt-5.6-sol' },
    createdAt: '2026-08-10T12:00:00.000Z',
  }
  const first = chainAuditEvent(input, null)
  const second = chainAuditEvent({ ...input, action: 'run.started' }, first.eventHash)
  assert.equal(first.eventHash.length, 64)
  assert.equal(second.previousHash, first.eventHash)
  assert.notEqual(first.eventHash, second.eventHash)
})
