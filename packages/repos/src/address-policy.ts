import { ADDRCONFIG } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { gitHostAllowlist } from "./config";
import { RepoError } from "./errors";
import { canonicalIpv6, expandIpv6, ipv4FromGroups, isPrivateIp } from "./private-ip";

/**
 * Which resolved addresses git and ssh-keyscan may connect to.
 *
 * On top of the shared private predicate (loopback, RFC 1918, CGNAT, ULA,
 * link-local, 169.254.169.254 metadata, multicast v4, unspecified) this refuses
 * the 6to4 relay anycast range 192.88.99.0/24, all of ::/8 (unspecified,
 * loopback, IPv4-mapped, IPv4-compatible and IPv4-translated
 * ::ffff:0:0:0/96), the discard prefix 100::/64, deprecated site-local
 * fec0::/10, IPv6 multicast and documentation space, the local-use NAT64
 * prefix 64:ff9b:1::/48, and unwraps the transition prefixes that carry an
 * IPv4 destination (NAT64 64:ff9b::/96, 6to4 2002::/16) so e.g.
 * 64:ff9b::a9fe:a9fe cannot reach the metadata service.
 *
 * IPv6 is classified on its eight numeric groups, so every spelling of an
 * address ("0:0:0:0:0:0:0:1", "0::1", "::1") gets the same answer.
 */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return isForbiddenIpv4(address);

  const groups = expandIpv6(address);
  if (!groups) return true;
  if (isPrivateIp(address, 6)) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  if (g0 === 0x0064 && g1 === 0xff9b) {
    // NAT64 well-known prefix 64:ff9b::/96: the last 32 bits are the IPv4
    // destination. The rest of 64:ff9b::/32 (local-use 64:ff9b:1::/48 and
    // unassigned space) is refused.
    if (g2 !== 0 || g3 !== 0 || g4 !== 0 || g5 !== 0) return true;
    return isForbiddenIpv4(ipv4FromGroups(groups[6] ?? 0, groups[7] ?? 0));
  }
  if (g0 < 0x0100) return true; // the rest of ::/8 — every IPv4-embedding and reserved form
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard 100::/64
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if (g0 >= 0xff00) return true; // multicast ff00::/8
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation 2001:db8::/32
  if (g0 === 0x2002) {
    // 6to4: bits 16..48 are the IPv4 destination.
    return isForbiddenIpv4(ipv4FromGroups(g1, g2));
  }
  return false;
}

function isForbiddenIpv4(address: string): boolean {
  if (isPrivateIp(address, 4)) return true;
  const [a, b, c] = address.split(".").map(Number);
  return a === 192 && b === 88 && c === 99; // 6to4 relay anycast 192.88.99.0/24
}

/**
 * Cloud metadata endpoints that sit INSIDE a range an allowlisted internal
 * host may otherwise use (Alibaba Cloud 100.100.100.200 in CGNAT, AWS
 * fd00:ec2::254 in unique-local). The link-local ones (169.254.169.254 and
 * friends, fe80::/10) are outside those ranges and so refused regardless.
 */
const METADATA_ADDRESSES = new Set(["100.100.100.200", "fd00:ec2::254"]);

/**
 * An internal-network address an operator-allowlisted git host may resolve
 * to: IPv4 RFC 1918 (10/8, 172.16/12, 192.168/16) or CGNAT 100.64.0.0/10, or
 * native IPv6 unique-local fc00::/7 — minus the metadata endpoints above.
 * Deliberately narrow: loopback, link-local, unspecified, multicast,
 * broadcast, benchmarking, documentation and every IPv4-embedding IPv6 form
 * (mapped, compatible, NAT64, 6to4) of ANY address are never internal, so
 * they stay refused through `isForbiddenAddress`.
 */
function isInternalNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    if (METADATA_ADDRESSES.has(address)) return false;
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
    const [a, b] = parts as [number, number, number, number];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (family !== 6 || address.includes("%")) return false;
  const canonical = canonicalIpv6(address);
  if (!canonical || METADATA_ADDRESSES.has(canonical)) return false;
  const groups = expandIpv6(address);
  return groups !== null && ((groups[0] ?? 0) & 0xfe00) === 0xfc00;
}

/**
 * The address check for one host: `isForbiddenAddress`, relaxed to admit
 * `isInternalNetworkAddress` answers only when the host NAME is on the
 * operator's allowlist. IP literals are never allowlisted.
 */
function isRefusedFor(allowlisted: boolean, address: string): boolean {
  if (!isForbiddenAddress(address)) return false;
  return !(allowlisted && isInternalNetworkAddress(canonicalAddress(address)));
}

/** The spelling an address check and a pinned connect use: canonical IPv6, IPv4 as is. */
export function canonicalAddress(address: string): string {
  return isIP(address) === 6 ? (canonicalIpv6(address) ?? address) : address;
}

/** `dns.lookup` shape, injectable for tests. */
export type HostResolver = (host: string) => Promise<string[]>;

// ADDRCONFIG: only ask for the address families this host can actually use.
const systemResolver: HostResolver = async (host) => {
  const results = await lookup(host, { all: true, verbatim: true, hints: ADDRCONFIG });
  return results.map((entry) => entry.address);
};

/**
 * Resolve `host` and return the address to connect to. Every address the
 * name resolves to must be public — one private answer refuses the host, so a
 * round-robin record cannot smuggle an internal address in. A host NAME on
 * `COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST` (exact match) may also resolve to
 * internal-network addresses (`isInternalNetworkAddress`); loopback,
 * link-local and metadata answers still refuse it. The caller pins
 * the returned address into the git/ssh invocation, so git never resolves the
 * name itself (no DNS-rebinding window between this check and the connect).
 * An IPv4 answer is preferred: it works on hosts without IPv6 connectivity.
 * IPv6 addresses are returned in canonical form.
 */
export async function resolvePublicAddress(
  host: string,
  resolver: HostResolver = systemResolver,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Overrides `COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST` (tests). */
    allowlist?: readonly string[];
  } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0) {
    const canonical = canonicalAddress(literal);
    if (isForbiddenAddress(canonical)) {
      throw new RepoError(
        "PRIVATE_ADDRESS",
        `Refusing to connect to private address ${canonical}.`,
      );
    }
    return canonical;
  }
  let addresses: string[];
  try {
    // The OS lookup cannot be canceled, but its result must not hold a git
    // operation or repository lock indefinitely. Observe either outcome so a
    // late rejection after cancellation never becomes unhandled.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      addresses = await new Promise<string[]>((resolve, reject) => {
        const signal = options.signal;
        onAbort = () => reject(signal?.reason);
        timer = setTimeout(
          () => reject(new Error("DNS lookup timed out.")),
          options.timeoutMs ?? 10_000,
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(() => {
            signal?.throwIfAborted();
            return resolver(host);
          })
          .then(resolve, reject);
        if (signal?.aborted) onAbort();
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new RepoError("HOST_UNRESOLVABLE", `Could not resolve ${host}.`, {}, { cause: error });
  }
  if (addresses.length === 0) {
    throw new RepoError("HOST_UNRESOLVABLE", `Could not resolve ${host}.`);
  }
  const allowlisted = (options.allowlist ?? gitHostAllowlist()).includes(host.toLowerCase());
  if (addresses.some((address) => isRefusedFor(allowlisted, address))) {
    throw new RepoError(
      "PRIVATE_ADDRESS",
      allowlisted
        ? `Refusing to connect to ${host}: it resolves to a loopback, link-local or metadata address.`
        : `Refusing to connect to ${host}: it resolves to a private, loopback or link-local address.`,
    );
  }
  const chosen = addresses.find((address) => isIP(address) === 4) ?? addresses[0];
  if (!chosen) throw new RepoError("HOST_UNRESOLVABLE", `Could not resolve ${host}.`);
  return canonicalAddress(chosen);
}
