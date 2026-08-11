import type { ProbeId, RunConfig, RunEstimate } from '../contracts/private-runs.js'
import { AppError } from '../errors.js'
import {
  DEFAULT_INPUT_PRICE_PER_MILLION,
  DEFAULT_OUTPUT_PRICE_PER_MILLION,
  EXPECTED_OUTPUT_TOKENS,
  FIXED_32K_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  SHORT_INPUT_TOKENS,
} from './run-limits.js'

export interface RunPricing {
  input_per_million: number
  output_per_million: number
  multiplier: number
}

function profiles(probeId: ProbeId, config: RunConfig): string[] {
  const values = config.formats.flatMap((format) => config.contexts.map((context) => `${format}+${context}`))
  return probeId === 'b80_letter_count' ? values.filter((value) => value === 'normal+no_history') : values
}

export function estimateRun(
  config: RunConfig,
  maximumBudgetUsd: number,
  maximumRequests: number,
  pricing: RunPricing = {
    input_per_million: DEFAULT_INPUT_PRICE_PER_MILLION,
    output_per_million: DEFAULT_OUTPUT_PRICE_PER_MILLION,
    multiplier: 1,
  },
): RunEstimate {
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
  const maximumAttempts = requests * (config.retries + 1)
  if (maximumAttempts > maximumRequests) {
    throw new AppError(400, 'request_limit_exceeded', `The run could issue ${maximumAttempts} attempts; maximum is ${maximumRequests}.`)
  }
  const inputTokens = longContextRequests * FIXED_32K_INPUT_TOKENS + (requests - longContextRequests) * SHORT_INPUT_TOKENS
  const outputTokens = requests * EXPECTED_OUTPUT_TOKENS
  const maximumInputTokens = inputTokens * (config.retries + 1)
  const maximumOutputTokens = requests * MAX_OUTPUT_TOKENS * (config.retries + 1)
  const cost = (input: number, output: number) => (
    ((input / 1_000_000) * pricing.input_per_million + (output / 1_000_000) * pricing.output_per_million)
    * pricing.multiplier
  )
  const estimate = cost(inputTokens, outputTokens)
  const maximumCost = Math.max(0.01, Math.ceil(cost(maximumInputTokens, maximumOutputTokens) * 1.25 * 100) / 100)
  if (maximumCost > maximumBudgetUsd) {
    throw new AppError(400, 'budget_limit_exceeded', `Estimated maximum cost ${maximumCost.toFixed(2)} exceeds the submitted budget.`)
  }
  return {
    requests,
    maximum_attempts: maximumAttempts,
    long_context_requests: longContextRequests,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    maximum_input_tokens: maximumInputTokens,
    maximum_output_tokens: maximumOutputTokens,
    estimated_seconds: Math.round(weightedSeconds / config.workers),
    estimated_cost_usd: Number(estimate.toFixed(6)),
    maximum_cost_usd: maximumCost,
  }
}
