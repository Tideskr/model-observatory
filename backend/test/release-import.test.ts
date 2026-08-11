import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { defaultScoringReleaseManifest, importScoringRelease } from '../src/scoring/release-import.js'

test('v4 scoring release imports the v3 baseline and calibrated reliability evidence', async () => {
  const seed = await importScoringRelease(defaultScoringReleaseManifest())
  assert.equal(seed.id, 'stage-c-trusted-fingerprint-v4')
  assert.equal(seed.scoringVersion, 'trusted-fingerprint-v3')
  assert.equal(seed.schemaVersion, 1)
  assert.equal(seed.probes.length, 11)
  assert.equal(seed.signatures.length, 27)
  assert.equal(seed.calibrations.length, 4)
  assert.ok(seed.calibrations.every((item) => item.formalEligible))
  const fingerprintCalibration = seed.artifact['fingerprint_calibration'] as Record<string, unknown>
  assert.equal(fingerprintCalibration['calibration_id'], 'gpt56-v3-local-plus-20260811')
  assert.equal((fingerprintCalibration['formal_gate_reliability'] as unknown[]).length, 6)
})

test('release import rejects an artifact changed without a manifest update', async () => {
  const source = resolve(process.cwd(), '..', 'scoring-releases', 'gpt56-v4')
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

test('release import rejects calibration evidence changed without a manifest update', async () => {
  const source = resolve(process.cwd(), '..', 'scoring-releases', 'gpt56-v4')
  const directory = await mkdtemp(join(tmpdir(), 'model-observatory-calibration-'))
  try {
    await cp(source, directory, { recursive: true })
    const calibrationPath = join(directory, 'fingerprint_calibration.json')
    const calibration = await readFile(calibrationPath, 'utf8')
    await writeFile(calibrationPath, calibration.replace('"selected": 48', '"selected": 47'))
    await assert.rejects(() => importScoringRelease(join(directory, 'manifest.json')), /source hash mismatch/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
