import { isIP } from "node:net";

import {
  canonicalAddress,
  type HostResolver,
  isForbiddenAddress,
  resolvePublicAddress,
} from "./address-policy";
import { RepoError } from "./errors";

/**
 * Git remote URL parsing, normalization and validation
 * (docs/product.md).
 *
 * Accepted:
 *   https://host[:port]/path[.git]
 *   ssh://user@host[:port]/path
 *   user@host:path                 (scp-like)
 *
 * Refused: every other scheme (file, git, ext, http, `transport::address`,
 * local paths), userinfo in HTTPS URLs, query strings and fragments, hosts and
 * paths that could be read as options (`-oProxyCommand=…`), whitespace and
 * control characters, and hosts that are — or resolve to — loopback, private,
 * link-local or metadata addresses. The DNS check runs again at every connect
 * (./network.ts), which pins the checked address into the git invocation.
 */

type RemoteKind = "https" | "ssh";

export interface ParsedRemote {
  kind: RemoteKind;
  /** Lowercased host name or IP literal (IPv6 without brackets). */
  host: string;
  port: number;
  /** SSH login user; undefined for HTTPS. */
  user?: string;
  /** What git is given. */
  remoteUrl: string;
  /** Normalized dedupe key: lowercased host, no `.git`, no trailing slash. */
  remoteKey: string;
}

const MAX_URL_LENGTH = 2_048;
const SSH_USER = /^[A-Za-z0-9._-]{1,64}$/;
/** RFC 3986 path characters (percent-encoding allowed), no backslash or whitespace. */
const HTTPS_PATH =
  /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*[A-Za-z0-9._~!$&'()*+,;=:@%-][A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
/** SSH repository paths: conservative, never option-like. */
const SSH_PATH = /^(?!-)[A-Za-z0-9._~/@+-]*[A-Za-z0-9._~@+-][A-Za-z0-9._~/@+-]*$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCP_LIKE = /^([A-Za-z0-9._-]{1,64})@([A-Za-z0-9.-]{1,253}):(.+)$/;

function invalid(reason: string, message: string): RepoError {
  return new RepoError("INVALID_REMOTE_URL", message, { reason });
}

/**
 * Validate a host name or IP literal and return it lowercased (IPv6 without
 * brackets, in RFC 5952 canonical form). Literal private addresses are
 * refused here, synchronously.
 */
export function normalizeHost(rawHost: string): string {
  const unbracketed =
    rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const lowered = unbracketed.toLowerCase();
  const family = isIP(lowered);
  if (family !== 0) {
    // One spelling per address, so the check, the stored host and the
    // dedupe key can never disagree ("0:0::1" is "::1").
    const host = canonicalAddress(lowered);
    if (isForbiddenAddress(host)) {
      throw new RepoError("PRIVATE_ADDRESS", `Refusing private address ${host}.`, {
        reason: "private_address",
      });
    }
    // A zone id only makes sense on a link-local address, refused above.
    if (lowered.includes("%")) throw invalid("host", "Invalid host name.");
    return host;
  }
  const host = lowered;
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new RepoError("PRIVATE_ADDRESS", "Refusing localhost.", { reason: "private_address" });
  }
  if (host.length > 253 || host.endsWith(".")) throw invalid("host", "Invalid host name.");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) {
    throw invalid("host", "The host must be a fully qualified domain name.");
  }
  const tld = labels.at(-1) ?? "";
  if (/^[0-9]+$/.test(tld)) throw invalid("host", "Invalid host name.");
  return host;
}

function hostForUrl(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function hostPort(host: string, port: number, defaultPort: number): string {
  return port === defaultPort ? hostForUrl(host) : `${hostForUrl(host)}:${port}`;
}

/** Drop trailing slashes and one `.git` suffix: the dedupe form of a path. */
export function normalizeRepoPath(path: string): string {
  let out = path.replace(/\/+$/, "");
  if (out.toLowerCase().endsWith(".git")) out = out.slice(0, -4);
  return out.replace(/\/+$/, "");
}

function parsePort(raw: string, fallback: number): number {
  if (raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalid("port", "Invalid port.");
  }
  return port;
}

function parseUrlForm(input: string): URL {
  try {
    return new URL(input);
  } catch {
    throw invalid("malformed", "The URL could not be parsed.");
  }
}

function parseHttps(input: string): ParsedRemote {
  const url = parseUrlForm(input);
  if (url.username || url.password) {
    throw invalid("userinfo", "HTTPS remotes must not contain a user name or password.");
  }
  if (url.search || url.hash || input.includes("?") || input.includes("#")) {
    throw invalid("query", "Remote URLs must not have a query string or fragment.");
  }
  const host = normalizeHost(url.hostname);
  const port = parsePort(url.port, 443);
  const path = url.pathname;
  if (!HTTPS_PATH.test(path) || path.split("/").some((segment) => segment === "..")) {
    throw invalid("path", "The repository path is missing or contains unsupported characters.");
  }
  const authority = hostPort(host, port, 443);
  return {
    kind: "https",
    host,
    port,
    remoteUrl: `https://${authority}${path}`,
    remoteKey: `https://${authority}${normalizeRepoPath(path)}`,
  };
}

function checkSshPath(path: string): void {
  if (!SSH_PATH.test(path) || path.split("/").some((segment) => segment === "..")) {
    throw invalid("path", "The repository path is missing or contains unsupported characters.");
  }
}

function checkSshUser(user: string): string {
  if (!SSH_USER.test(user) || user.startsWith("-")) {
    throw invalid("user", "SSH remotes need a plain login user, e.g. git@host:owner/repo.");
  }
  return user;
}

function parseSshUrl(input: string): ParsedRemote {
  const url = parseUrlForm(input);
  if (url.password) throw invalid("userinfo", "SSH remotes must not contain a password.");
  if (url.search || url.hash || input.includes("?") || input.includes("#")) {
    throw invalid("query", "Remote URLs must not have a query string or fragment.");
  }
  const user = checkSshUser(decodeURIComponent(url.username));
  const host = normalizeHost(url.hostname);
  const port = parsePort(url.port, 22);
  const path = url.pathname;
  checkSshPath(path);
  const authority = `${user}@${hostPort(host, port, 22)}`;
  return {
    kind: "ssh",
    host,
    port,
    user,
    remoteUrl: `ssh://${authority}${path}`,
    remoteKey: `ssh://${authority}${normalizeRepoPath(path)}`,
  };
}

/**
 * Forges where a home-relative scp path (`git@github.com:owner/repo`) and the
 * absolute ssh:// path (`ssh://git@github.com/owner/repo`) name the same
 * repository. On an arbitrary SSH server the scp path is relative to the
 * login's home directory, so the two spellings stay distinct there.
 */
const ROOT_RELATIVE_SCP_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
]);

/**
 * The dedupe key of an scp-like remote: the ssh:// key whenever the two
 * spellings provably reach the same repository (an absolute path, or a forge
 * above), so `git@host:owner/repo` and `ssh://git@host/owner/repo` share one
 * clone. Otherwise the scp spelling itself.
 */
function scpRemoteKey(user: string, host: string, path: string): string {
  const normalized = normalizeRepoPath(path);
  if (path.startsWith("/")) return `ssh://${user}@${host}${normalized}`;
  if (ROOT_RELATIVE_SCP_HOSTS.has(host)) return `ssh://${user}@${host}/${normalized}`;
  return `${user}@${host}:${normalized}`;
}

function parseScpLike(input: string): ParsedRemote | null {
  const match = SCP_LIKE.exec(input);
  if (!match) return null;
  const [, rawUser = "", rawHost = "", path = ""] = match;
  const user = checkSshUser(rawUser);
  const host = normalizeHost(rawHost);
  checkSshPath(path);
  return {
    kind: "ssh",
    host,
    port: 22,
    user,
    remoteUrl: `${user}@${host}:${path}`,
    remoteKey: scpRemoteKey(user, host, path),
  };
}

/** Syntactic validation and normalization. Throws RepoError (INVALID_REMOTE_URL / PRIVATE_ADDRESS). */
export function parseRemoteUrl(rawInput: string): ParsedRemote {
  const input = rawInput.trim();
  if (input.length === 0 || input.length > MAX_URL_LENGTH) {
    throw invalid("length", "The remote URL is empty or too long.");
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\u0000- \u007f\\]/.test(input)) {
    throw invalid("characters", "The remote URL contains whitespace or control characters.");
  }
  const lower = input.toLowerCase();
  if (lower.startsWith("https://")) return parseHttps(input);
  if (lower.startsWith("ssh://")) return parseSshUrl(input);
  if (input.includes("://") || input.includes("::")) {
    throw invalid("unsupported_scheme", "Only https:// and SSH remotes are supported.");
  }
  const scp = parseScpLike(input);
  if (scp) return scp;
  throw invalid("unsupported_scheme", "Only https:// and SSH remotes are supported.");
}

/**
 * Full validation for saving a package's git URL: syntax plus a DNS check
 * that every address the host resolves to is public.
 */
export async function validateRemoteUrl(
  input: string,
  resolver?: HostResolver,
  options: { signal?: AbortSignal } = {},
): Promise<ParsedRemote> {
  const parsed = parseRemoteUrl(input);
  await resolvePublicAddress(parsed.host, resolver, options);
  return parsed;
}
