import { isIP } from "node:net";
import { env } from "@cockpit-context/env/server";
import { isInfraIp } from "@cockpit-context/repos/private-ip";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

// Several limiters and the oRPC context resolve the same raw request.
// Weak keys release the memo when a request finishes.
const resolved = new WeakMap<Request, string>();

/**
 * Resolve the client IP for an anonymous request. This is the rate-limit and
 * audit key for traffic that isn't tied to a user id.
 *
 * `X-Forwarded-For` is `<client-supplied>, <appended by hop 1>, <hop 2>, ...`.
 * Everything a client sends is forgeable; each trusted proxy APPENDS the
 * address it received the request from. The chain we read is therefore
 * `[...X-Forwarded-For, socketPeer]`, and only the rightmost entries written
 * by proxies we actually run can be trusted.
 *
 * TRUST_PROXY_HOPS = N (default 0) is the exact number of trusted reverse
 * proxies between the client and the app:
 *
 * - N = 0 (default): key on the TCP socket peer and ignore `X-Forwarded-For`
 *   entirely. Correct for direct exposure and LAN deploys. A deployment that
 *   sits behind a proxy but leaves N = 0 keys every client on the proxy's
 *   address — one shared bucket — which fails safe (over-limits) rather than
 *   letting clients choose their own key.
 * - N >= 1: the client is the entry N positions left of the socket peer. The
 *   operator sets 1 behind Traefik/Dokploy. The app must be reachable
 *   ONLY through that chain, or a direct caller can forge the entries.
 *
 * Some proxies (Azure Application Gateway by default) append the client's
 * source port: `1.2.3.4:5678` or `[2001:db8::1]:5678`. The selected entry has
 * that port removed before validation; a bare IPv6 literal is left alone.
 *
 * There is no private-hop heuristic and no fallback to the leftmost
 * (client-supplied) entry: when the chain is shorter than N + 1, or the
 * selected entry is not an IP literal, the request did not arrive through the
 * configured proxies and is keyed on the socket peer instead.
 */
export function resolveClientIp(c: Context): string {
  const raw = c.req.raw;
  const cached = resolved.get(raw);
  if (cached !== undefined) return cached;
  const ip = computeClientIp(c);
  resolved.set(raw, ip);
  return ip;
}

function computeClientIp(c: Context): string {
  const socket = getConnInfo(c).remote.address || "unknown";
  // Without a transport peer there is no chain to anchor header trust to.
  if (socket === "unknown") return socket;
  const header = c.req.header("x-forwarded-for");
  const hops = env.TRUST_PROXY_HOPS ?? 0;
  if (hops === 0) {
    if (header) warnUntrustedForwardedOnce(socket);
    return socket;
  }

  const forwarded = (header ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // `forwarded[forwarded.length - hops]` is N-from-right in [...xff, socket].
  const selected = forwarded[forwarded.length - hops];
  if (selected === undefined) return socket;
  const candidate = stripForwardedPort(selected);
  if (isIP(candidate) === 0) return socket;
  return candidate;
}

const BRACKETED_V6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/;
const V4_WITH_PORT = /^([^:]+):(\d{1,5})$/;

/**
 * Remove a proxy-appended port from ONE selected entry: `1.2.3.4:5678` →
 * `1.2.3.4`, `[2001:db8::1]:5678` (or `[2001:db8::1]`) → `2001:db8::1`. A
 * bracket form must hold IPv6 and the `host:port` form IPv4; anything else is
 * returned unchanged and fails the caller's `isIP` check. A bare IPv6 literal
 * has several colons and never matches the IPv4 form.
 */
function stripForwardedPort(entry: string): string {
  const bracketed = BRACKETED_V6.exec(entry);
  if (bracketed) {
    const [, host = "", port] = bracketed;
    return isIP(host) === 6 && validPort(port) ? host : entry;
  }
  const v4 = V4_WITH_PORT.exec(entry);
  if (v4) {
    const [, host = "", port] = v4;
    return isIP(host) === 4 && validPort(port) ? host : entry;
  }
  return entry;
}

function validPort(port: string | undefined): boolean {
  return port === undefined || Number(port) <= 65535;
}

let warnedUntrustedForwarded = false;

/**
 * A private socket peer sending X-Forwarded-For while TRUST_PROXY_HOPS is 0 is
 * almost always a reverse proxy the operator has not counted, which collapses
 * every client into the proxy's bucket. Say so once per process; the request
 * is still keyed on the socket peer (a LAN client spoofing the header only
 * triggers this one-time record). The message names no address.
 */
function warnUntrustedForwardedOnce(socket: string): void {
  if (warnedUntrustedForwarded) return;
  const version = isIP(socket);
  if (version === 0 || !isInfraIp(socket, version)) return;
  warnedUntrustedForwarded = true;
  console.warn(
    "[client-ip] a private peer sent X-Forwarded-For while TRUST_PROXY_HOPS is 0; " +
      "every client behind that proxy shares one rate-limit bucket. Set TRUST_PROXY_HOPS " +
      "to the number of trusted reverse proxies.",
  );
}
