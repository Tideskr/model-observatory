import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { AppError } from '../errors.js'

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

export interface PinnedAddress {
  address: string
  family: 4 | 6
}

export function isBlockedAddress(address: string, family = isIP(address)): boolean {
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
    return mapped ? blocked.check(mapped, 'ipv4') : blocked.check(address, 'ipv6')
  }
  return true
}

export function assertSafeTargetHostname(hostname: string): void {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  ) {
    throw new AppError(400, 'target_not_public', 'The target hostname is not publicly routable.')
  }
  const family = isIP(normalized)
  if (family && isBlockedAddress(normalized, family)) {
    throw new AppError(400, 'target_not_public', 'The target address is not publicly routable.')
  }
}

export async function resolvePublicTarget(hostname: string): Promise<PinnedAddress> {
  assertSafeTargetHostname(hostname)
  let addresses: { address: string; family: 4 | 6 }[]
  try {
    addresses = (await lookup(hostname, { all: true, verbatim: true })).map((item) => ({
      address: item.address,
      family: item.family === 6 ? 6 : 4,
    }))
  } catch {
    throw new AppError(400, 'target_dns_failed', 'The target hostname could not be resolved.')
  }
  if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address, item.family))) {
    throw new AppError(400, 'target_not_public', 'Every resolved target address must be publicly routable.')
  }
  const selected = addresses[0]!
  return { address: selected.address, family: selected.family }
}
