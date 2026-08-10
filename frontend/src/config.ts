/* Deployment-specific constants.
 *
 * TODO(owner): these are placeholders. The repository URL and the runner
 * download URL are not knowable from this working tree — fill them in before
 * shipping, or the Registry edit button and the runner download button will
 * point nowhere.
 */

/** Used to build prefilled issue URLs from the Registry edit dialog. */
export const REPO_URL = 'https://github.com/OWNER/REPO'

/** GitHub issue form template filename under .github/ISSUE_TEMPLATE/. */
export const PROBE_ISSUE_TEMPLATE = 'probe-change.yml'

/** Where the local runner is expected to listen. */
export const LOCAL_RUNNER_ORIGIN = 'http://127.0.0.1:8756'

/** Download page for the local runner. */
export const RUNNER_DOWNLOAD_URL = `${REPO_URL}/releases/latest`

export const CONFIG_PLACEHOLDERS_PENDING = REPO_URL.includes('OWNER')
