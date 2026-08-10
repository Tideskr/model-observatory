import type { ProbeId, RunConfig, RunEstimate } from '../contracts/private-runs.js'
import { AppError } from '../errors.js'

const FIXED_32K_INPUT_TOKENS = 33_792
const SHORT_INPUT_TOKENS = 320
const OUTPUT_TOKENS = 40
const INPUT_PRICE_PER_MILLION = 1.25
const OUTPUT_PRICE_PER_MILLION = 10

function profiles(probeId: ProbeId, config: RunConfig): string[] {
  const values = config.formats.flatMap((format) => config.contexts.map((context) => `${format}+${context}`))
  return probeId === 'b80_letter_count' ? values.filter((value) => value === 'normal+no_history') : values
}

export function estimateRun(config: RunConfig, maximumBudgetUsd: number, maximumRequests: number): RunEstimate {
  const seen = new Set<string>()
  let requests = 0
  let longContextRequests = 0
  let weightedSeconds = 0
  for (const selection of config.probes) {
    if (seen.has(selection.probe_id)) throw new AppError(400, 'duplicate_probe', `Probe ${selection.probe_id} is duplicated.`)
    seen.add(selection.probe_id)
    for (const profile of profiles(selection.probe_id, config)) {
      requests += selection.requests
      if (profile.endsWith('fixed_32k_history')) longContextRequests += selection.requests
      weightedSeconds += selection.requests * 3.5
    }
  }
  if (requests > maximumRequests) {
    throw new AppError(400, 'request_limit_exceeded', `The run would issue ${requests} requests; maximum is ${maximumRequests}.`)
  }
  const inputTokens = longContextRequests * FIXED_32K_INPUT_TOKENS + (requests - longContextRequests) * SHORT_INPUT_TOKENS
  const outputTokens = requests * OUTPUT_TOKENS
  const estimate = (inputTokens / 1_000_000) * INPUT_PRICE_PER_MILLION + (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_MILLION
  const maximumCost = Math.max(0.01, Math.ceil(estimate * 1.25 * 100) / 100)
  if (maximumCost > maximumBudgetUsd) {
    throw new AppError(400, 'budget_limit_exceeded', `Estimated maximum cost ${maximumCost.toFixed(2)} exceeds the submitted budget.`)
  }
  return {
    requests,
    long_context_requests: longContextRequests,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_seconds: Math.round(weightedSeconds / config.workers),
    estimated_cost_usd: Number(estimate.toFixed(6)),
    maximum_cost_usd: maximumCost,
  }
}
