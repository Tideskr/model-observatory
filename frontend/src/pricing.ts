/* Price assumptions for the private-check cost estimate.
 *
 * Neither the archived detector nor the observation data carries pricing, so
 * these are assumptions, not facts. The private-check page exposes them as
 * editable inputs and labels the result as an estimate.
 *
 * Unit: USD per 1M tokens, at a 1.0x group multiplier.
 */

export interface PriceAssumption {
  inputPerMillion: number
  outputPerMillion: number
}

export const DEFAULT_PRICE: PriceAssumption = {
  inputPerMillion: 1.25,
  outputPerMillion: 10,
}

/** Relay groups resell at a multiplier of the official rate, e.g. 0.05x. */
export const DEFAULT_MULTIPLIER = 1

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  price: PriceAssumption,
  multiplier: number,
): number {
  const base =
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion
  return base * multiplier
}

export function formatUsd(value: number): string {
  if (value < 0.01) return '< US$0.01'
  return `US$${value.toFixed(2)}`
}
