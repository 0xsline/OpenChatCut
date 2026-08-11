import { isIP } from 'node:net';

/** True for IPv4, IPv6, and IPv4-mapped loopback socket addresses. */
export function isLoopbackAddress(address: string | undefined): address is string {
  if (!address) return false;
  if (address === '::1') return true;
  const normalized = address.toLowerCase();
  const ipv4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}
