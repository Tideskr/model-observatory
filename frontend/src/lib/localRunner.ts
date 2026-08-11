/* Local runner detection.
 *
 * The archived detector never faced this problem: it served its own page from
 * 127.0.0.1, so the browser and the runner were same-origin. A hosted page
 * reaching http://127.0.0.1 is a cross-origin, private-network request. A
 * compatible runner reflects any valid web Origin and answers the browser's
 * Private Network Access preflight.
 *
 * Failure is not an error state: it simply means "no runner", which the page
 * handles by offering the download.
 */

import { LOCAL_RUNNER_ORIGIN } from '../config'

export type RunnerState =
  /** Probe has not finished yet. */
  | { status: 'checking' }
  /** Runner answered — everything runs locally, key never leaves the machine. */
  | { status: 'present'; version: string; capabilities: Record<string, boolean> }
  /** No runner. The run is blocked until one is installed or remote is chosen. */
  | { status: 'absent' }
  /** User explicitly accepted sending credentials to the project's server. */
  | { status: 'remote' }

interface RunnerStatusResponse {
  service?: string
  version?: string
  capabilities?: Record<string, boolean>
}

const PROBE_TIMEOUT_MS = 800

type LoopbackRequestInit = RequestInit & { targetAddressSpace: 'loopback' }

/** One-shot probe. Deliberately not polled — the page should stay quiet. */
export async function detectLocalRunner(): Promise<RunnerState> {
  try {
    const request: LoopbackRequestInit = {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      mode: 'cors',
      targetAddressSpace: 'loopback',
    }
    const response = await fetch(`${LOCAL_RUNNER_ORIGIN}/status`, request)
    if (!response.ok) return { status: 'absent' }

    const body = (await response.json()) as RunnerStatusResponse
    if (body.service !== 'model-observatory-runner') return { status: 'absent' }

    return { status: 'present', version: body.version ?? 'unknown', capabilities: body.capabilities ?? {} }
  } catch {
    // Timeout, connection refused, CORS rejection — all mean "no usable runner".
    return { status: 'absent' }
  }
}

/** Native replay needs raw TCP/TLS control; only the local runner can do it. */
export function supportsNativeFormat(state: RunnerState): boolean {
  return state.status === 'present' && state.capabilities['native_codex'] === true
}

/** Whether credentials would leave the user's machine under this state. */
export function credentialsLeaveMachine(state: RunnerState): boolean {
  return state.status === 'remote'
}
