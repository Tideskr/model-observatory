import { loadConfig } from './config.js'
import { RunWorker } from './worker/run-worker.js'
import { DonationScheduler } from './worker/donation-scheduler.js'
import { createServices } from './services.js'

const config = loadConfig()
if (config.databaseUrl === 'memory:') throw new Error('The standalone worker requires PostgreSQL.')
const services = await createServices(config)
const worker = new RunWorker({
  services,
  loadScoringRelease: services.loadScoringRelease,
})
const controller = new AbortController()
const donations = new DonationScheduler({ config, services })
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
try {
  const donationLoop = async () => {
    while (!controller.signal.aborted) {
      const reconciled = await donations.reconcileOnce()
      const scheduled = await donations.scheduleOnce()
      if (!reconciled && !scheduled) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }
  }
  await Promise.all([worker.run(controller.signal), donationLoop()])
} finally {
  await services.close()
}
