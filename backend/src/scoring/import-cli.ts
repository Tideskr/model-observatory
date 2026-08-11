import { resolve } from 'node:path'
import { loadConfig } from '../config.js'
import { createDatabasePool } from '../db/connection.js'
import { defaultScoringReleaseManifest, importScoringRelease } from './release-import.js'
import { saveScoringRelease } from './repository.js'

const manifestPath = process.argv[2] ?? defaultScoringReleaseManifest()
const seed = await importScoringRelease(resolve(manifestPath))
const pool = createDatabasePool(loadConfig())
try {
  await saveScoringRelease(pool, seed)
  process.stdout.write(
    `Imported ${seed.id}: ${seed.probes.length} probes, ${seed.templates.length} templates, ${seed.signatures.length} signatures, ${seed.cells.length} cells, ${seed.calibrations.length} calibrations.\n`,
  )
} finally {
  await pool.end()
}
