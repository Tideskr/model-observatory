import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

test('Legacy source pins accept either checkout line ending', async () => {
  const root = resolve(process.cwd(), '..', 'Legacy', 'gpt56_vnext', 'baselines')
  const directory = await mkdtemp(join(tmpdir(), 'model-observatory-line-endings-'))
  try {
    const catalogPath = join(directory, 'runtime-catalog.json')
    const baselinePath = join(directory, 'trusted-baseline.json')
    const [catalog, baseline] = await Promise.all([
      readFile(resolve(root, 'runtime_catalog.json'), 'utf8'),
      readFile(resolve(root, 'trusted_likelihood_v2.json'), 'utf8'),
    ])
    await Promise.all([
      writeFile(catalogPath, catalog.replace(/\r\n/g, '\n')),
      writeFile(baselinePath, baseline.replace(/\r\n/g, '\n')),
    ])
    const seed = await importLegacyScoringRelease(catalogPath, baselinePath)
    assert.equal(seed.id, 'stage-c-trusted-likelihood-v2')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Legacy import rejects a baseline whose trusted source content was changed', async () => {
  const root = resolve(process.cwd(), '..', 'Legacy', 'gpt56_vnext', 'baselines')
  const directory = await mkdtemp(join(tmpdir(), 'model-observatory-baseline-'))
  try {
    const baseline = await readFile(resolve(root, 'trusted_likelihood_v2.json'), 'utf8')
    const changedPath = join(directory, 'changed-baseline.json')
    await writeFile(changedPath, baseline.replace('"smoothing_alpha": 0.5', '"smoothing_alpha": 0.6'))
    await assert.rejects(
      () => importLegacyScoringRelease(resolve(root, 'runtime_catalog.json'), changedPath),
      /source hash mismatch/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
