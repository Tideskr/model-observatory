/* Visual encoding scales.
 *
 * Pure mapping from a value to a visual token — no business rules. Thresholds
 * that decide what counts as a problem live in confidence.ts.
 */

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral'

export type MeterTone = 'good' | 'caution' | 'risk'

export function meterTone(value: number): MeterTone {
  return value >= 75 ? 'good' : value >= 50 ? 'caution' : 'risk'
}

/** Anomaly severity uses the reserved status scale, never a series colour. */
export const severityTone: Record<'hard' | 'soft', Tone> = {
  hard: 'bad',
  soft: 'warn',
}

export const severityLabel: Record<'hard' | 'soft', string> = {
  hard: '硬异常',
  soft: '待复核',
}
