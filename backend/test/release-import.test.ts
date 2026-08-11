import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { defaultScoringReleaseManifest, importScoringRelease } from '../src/scoring/release-import.js'

test('v3 scoring release imports the canonical manifest and all data groups', async () => {
  const seed = await importScoringRelease(defaultScoringReleaseManifest())
  assert.equal(seed.id, 'stage-c-trusted-fingerprint-v3')
  assert.equal(seed.scoringVersion, 'trusted-fingerprint-v3')
  assert.equal(seed.schemaVersion, 1)
  assert.equal(seed.probes.length, 11)
  assert.equal(seed.signatures.length, 27)
  assert.equal(seed.calibrations.length, 4)
  assert.ok(seed.calibrations.every((item) => item.formalEligible))
})

test('release import rejects an artifact changed without a manifest update', async () => {
  const source = resolve(process.cwd(), '..', 'scoring-releases', 'gpt56-v3')
  const directory = await mkdtemp(join(tmpdir(), 'model-observatory-release-'))
  try {
    await cp(source, directory, { recursive: true })
    const baselinePath = join(directory, 'trusted_fingerprint_v3.json')
    const baseline = await readFile(baselinePath, 'utf8')
    await writeFile(baselinePath, baseline.replace('"smoothing_alpha": 0.5', '"smoothing_alpha": 0.6'))
    await assert.rejects(() => importScoringRelease(join(directory, 'manifest.json')), /source hash mismatch/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
