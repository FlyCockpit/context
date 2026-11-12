// Shared private/non-routable IP predicates.
//
// Used both by the git layer's SSRF guard (./address-policy.ts, which adds a
// few git-specific ranges on top) — where a private result means "refuse to
// connect" — and by the server's client-IP resolver (apps/server/src/client-ip.ts)
// — where a private result means "this hop is our own infra, a trusted proxy,
// not the real client."
//
// Both callers fail closed: anything we can't positively classify as public is
// treated as private. The IPv6 path works on the eight numeric groups (so no
// alternative spelling slips past a string comparison), unwraps IPv4-mapped
// and IPv4-compatible addresses and reuses the IPv4 predicate so the two never
// drift.

import { isIP } from "node:net";

export function isPrivateIp(address: string, family: number): boolean {
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  // Classify the eight numeric groups, never the spelling: "0:0:0:0:0:0:0:1",
  // "0::1" and "::1" are the same loopback address.
  const groups = expandIpv6(address);
  if (!groups) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // IPv4-mapped ::ffff:0:0/96 and the deprecated IPv4-compatible ::/96
    // (which includes :: and ::1, i.e. 0.0.0.0 and 0.0.0.1) carry an IPv4
    // destination: unwrap and run the IPv4 predicate so e.g.
    // ::ffff:169.254.169.254 is blocked.
    if (g5 === 0xffff || g5 === 0) return isPrivateIpv4(ipv4FromGroups(g6, g7));
  }

  // Unique-local fc00::/7 (fc.. and fd..).
  if ((g0 & 0xfe00) === 0xfc00) return true;

  // Link-local fe80::/10 — the whole fe80::–febf:: span, not just fe80:.
  if ((g0 & 0xffc0) === 0xfe80) return true;

  return false;
}

/** Dotted IPv4 form of two 16-bit groups. */
export function ipv4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * The eight 16-bit groups of an IPv6 literal (any spelling: compressed,
 * uncompressed, leading zeros, dotted IPv4 tail; a zone id is dropped), or
 * null when it is not one.
 */
export function expandIpv6(address: string): number[] | null {
  const zone = address.indexOf("%");
  let text = (zone === -1 ? address : address.slice(0, zone)).toLowerCase();
  if (isIP(text) !== 6) return null;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const words = [...head, ...Array<string>(fill).fill("0"), ...rest];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

/**
 * The RFC 5952 canonical text of an IPv6 literal (lowercase, no leading
 * zeros, the longest run of two or more zero groups compressed to "::", no
 * dotted tail, no zone id), or null when it is not one. Stored hosts and
 * every address check use this spelling.
 */
export function canonicalIpv6(address: string): string | null {
  const groups = expandIpv6(address);
  if (!groups) return null;
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const rest = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${rest}`;
}
