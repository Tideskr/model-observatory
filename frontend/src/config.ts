/* Deployment-specific constants. */

/** Used to build prefilled issue URLs from the Registry edit dialog. */
export const REPO_URL = 'https://github.com/Tideskr/model-observatory'

/** GitHub issue form template filename under .github/ISSUE_TEMPLATE/. */
export const PROBE_ISSUE_TEMPLATE = 'probe-change.yml'

/** Where the local runner is expected to listen. */
export const LOCAL_RUNNER_ORIGIN = 'http://127.0.0.1:8756'

/** Optional origin for deployments where the frontend and API are separate. */
export const API_ORIGIN = String(import.meta.env.VITE_API_ORIGIN ?? '').replace(/\/+$/, '')

export function apiUrl(path: string, origin = API_ORIGIN): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${origin.replace(/\/+$/, '')}${normalizedPath}`
}

/** Download page for the local runner. */
export const RUNNER_DOWNLOAD_URL = `${REPO_URL}/releases/latest`

export const CONFIG_PLACEHOLDERS_PENDING = REPO_URL.includes('OWNER')
