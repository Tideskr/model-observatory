import type { RunConfig } from '../contracts/private-runs.js'
import { estimateRun, type RunPricing } from './run-estimate.js'

export const DONATION_MEDIUM_CONFIG: RunConfig = {
  probes: [
    { probe_id: 'juice_high', requests: 12 },
    { probe_id: 'juice_low', requests: 6 },
    { probe_id: 'juice_xhigh', requests: 6 },
    { probe_id: 'juice_max', requests: 6 },
    { probe_id: 'output_luna_48', requests: 1 },
    { probe_id: 'output_terra_32', requests: 1 },
    { probe_id: 'juice_coverage', requests: 2 },
    { probe_id: 'rand_country', requests: 20 },
    { probe_id: 'b80_letter_count', requests: 10 },
  ],
  formats: ['normal'],
  contexts: ['no_history'],
  workers: 8,
  retries: 2,
}

export function donationModelEstimate(pricing: RunPricing) {
  return estimateRun(DONATION_MEDIUM_CONFIG, 1000, 500, pricing)
}
