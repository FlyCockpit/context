/**
 * The doctor's `TRUST_PROXY_HOPS` check, pure so it is unit-testable (see
 * trust-proxy-hops-env.test.ts; `scripts/doctor.ts` records the verdict).
 *
 * The app serves plain HTTP only, so a deployment whose public URL is
 * `https://` on a real host always has at least one proxy in front of it:
 * Caddy, Traefik/Dokploy or `cloudflared`. With the default `0` the server
 * keys every client on that proxy's address, one shared rate-limit and
 * sign-in-failure bucket (apps/server/src/client-ip.ts). Production is
 * detected by `NODE_ENV=production` (Compose sets it) or by that public
 * `https` URL, since a host checkout's `.env` usually leaves `NODE_ENV` to
 * Compose. Values are compared, never printed (the hop count is not secret).
 */

export type ProxyHopsVerdict = {
  status: "ok" | "warn";
  detail: string;
  hint?: string;
};

type ProxyHopsEnv = {
  NODE_ENV?: string;
  BETTER_AUTH_URL?: string;
  TRUST_PROXY_HOPS?: string;
};

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** True for `NODE_ENV=production` or an `https` public URL on a non-local host. */
export function looksDeployed(env: ProxyHopsEnv): boolean {
  if (env.NODE_ENV === "production") return true;
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? "");
    return url.protocol === "https:" && !isLocalHost(url.hostname);
  } catch {
    return false;
  }
}

export function checkTrustProxyHops(env: ProxyHopsEnv): ProxyHopsVerdict {
  const raw = env.TRUST_PROXY_HOPS?.trim() ?? "";
  const hops = raw === "" ? 0 : Number(raw);
  // An invalid value is the env schema check's to report.
  if (!Number.isInteger(hops) || hops < 0) {
    return { status: "ok", detail: "not checked (TRUST_PROXY_HOPS is invalid; see env check)" };
  }
  if (hops > 0)
    return { status: "ok", detail: `${hops} trusted proxy hop${hops === 1 ? "" : "s"}` };
  if (!looksDeployed(env)) {
    return { status: "ok", detail: "0 (direct; fine for local development)" };
  }
  return {
    status: "warn",
    detail:
      "TRUST_PROXY_HOPS is 0 on a deployment: every client behind the proxy shares one rate-limit and sign-in-failure bucket",
    hint:
      "Set TRUST_PROXY_HOPS to the number of proxies in front of the app: 1 behind Caddy, " +
      "Traefik/Dokploy or a Cloudflare Tunnel straight to the app, 2 for a Cloudflare Tunnel " +
      "into Traefik/Caddy. See docs/deploy.md.",
  };
}
