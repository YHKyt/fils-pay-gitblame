import { isIP } from "node:net";

/**
 * SSRF policy for outbound webhook URLs: a merchant-controlled URL must never
 * reach loopback, private (RFC 1918 / ULA), link-local (incl. the cloud
 * metadata service at 169.254.169.254), CGNAT, multicast or otherwise
 * non-public addresses. Enforced in production only — dev/test keep their
 * local receivers.
 */

const IPV4_BLOCKED: Array<[number, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([base, bits]) => [ipv4ToInt(base as string), bits as number]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return IPV4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    return value >= base && value < base + size;
  });
}

/** Expands an IPv6 literal to 8 16-bit groups (handles "::" and a dotted IPv4 tail). */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const v = ipv4ToInt(tail);
    addr = `${addr.slice(0, lastColon + 1)}${(Math.floor(v / 65536)).toString(16)}:${(v % 65536).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isBlockedIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // unparseable: refuse
  const first = g[0]!;
  const allZeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded IPv4.
  if (allZeroPrefix(5) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
    return isBlockedIpv4(v4);
  }
  if (first === 0x64 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** True for any IP literal that is not a public unicast address. */
export function isNonPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

/**
 * True when a URL hostname is, on its face, a non-public target: an IP
 * literal in a blocked range, or a name that resolves locally by convention.
 * DNS names that resolve to private addresses are caught at send time by the
 * transport (see transport.ts).
 */
export function isBlockedHostname(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (isIP(host) !== 0) return isNonPublicAddress(host);
  if (host === "" || !host.includes(".")) return true; // single-label names (localhost, settlement, ...)
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain")
  );
}
