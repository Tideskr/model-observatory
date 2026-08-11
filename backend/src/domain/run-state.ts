import type { RunStatus } from '../contracts/common.js'
import { AppError } from '../errors.js'

const transitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['provisioning', 'cancelled', 'timed_out', 'failed', 'deleted'],
  provisioning: ['running', 'cancelled', 'timed_out', 'failed'],
  running: ['scoring', 'cancelled', 'timed_out', 'failed', 'incomplete'],
  scoring: ['completed', 'failed', 'cancelled', 'incomplete', 'timed_out'],
  completed: ['deleted'],
  failed: ['deleted'],
  cancelled: ['deleted'],
  timed_out: ['deleted'],
  incomplete: ['deleted'],
  deleted: [],
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return transitions[from].includes(to)
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new AppError(409, 'invalid_run_transition', `Run cannot transition from ${from} to ${to}.`)
  }
}
