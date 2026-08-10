import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { importLegacyScoringRelease } from '../src/scoring/legacy-import.js'

test('Legacy scoring data imports into normalized database records', async () => {
  const root = resolve(process.cwd(), '..', 'Legacy', 'gpt56_vnext', 'baselines')
  const seed = await importLegacyScoringRelease(
    resolve(root, 'runtime_catalog.json'),
    resolve(root, 'trusted_likelihood_v2.json'),
  )

  assert.equal(seed.id, 'stage-c-trusted-likelihood-v2')
  assert.equal(seed.scoringVersion, 'trusted-likelihood-v2')
  assert.equal(seed.contentSha256, 'dd692466ea601d99b737edae66a35941f236d5e7426244f2c04e43f314f43851')
  assert.equal(seed.models.length, 6)
  assert.equal(seed.probes.length, 11)
  assert.equal(seed.templates.length, 15)
  assert.equal(seed.signatures.length, 27)
  assert.equal(seed.cells.length, 12)
  assert.equal(seed.calibrations.length, 4)
  assert.ok(seed.calibrations.every((item) => item.formalEligible))
})
