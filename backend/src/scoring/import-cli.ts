import { resolve } from 'node:path'
import { loadConfig } from '../config.js'
import { createDatabasePool } from '../db/connection.js'
import { importLegacyScoringRelease } from './legacy-import.js'
import { saveScoringRelease } from './repository.js'

const legacyRoot = resolve(process.cwd(), '..', 'Legacy', 'gpt56_vnext', 'baselines')
const catalogPath = process.argv[2] ?? resolve(legacyRoot, 'runtime_catalog.json')
const baselinePath = process.argv[3] ?? resolve(legacyRoot, 'trusted_likelihood_v2.json')
const seed = await importLegacyScoringRelease(catalogPath, baselinePath)
const pool = createDatabasePool(loadConfig())
try {
  await saveScoringRelease(pool, seed)
  process.stdout.write(
    `Imported ${seed.id}: ${seed.probes.length} probes, ${seed.templates.length} templates, ${seed.signatures.length} signatures, ${seed.cells.length} cells, ${seed.calibrations.length} calibrations.\n`,
  )
} finally {
  await pool.end()
}
