import type { AppRouterClient } from "@cockpit-context/api/routers/index";

/**
 * Pure helpers for the Access pages (docs/mcp.md, docs/product.md
 * repositories § SSH keys and known hosts): token expiry choices, the
 * copy-paste agent config, the connection flags rule and the host-scan input.
 */

type Client = AppRouterClient;
export type McpToken = Awaited<ReturnType<Client["mcpTokens"]["list"]>>["items"][number];
export type McpConnection = Awaited<ReturnType<Client["mcpConnections"]["list"]>>["items"][number];
export type SshKey = Awaited<ReturnType<Client["sshKeys"]["list"]>>["items"][number];
export type KnownHost = Awaited<ReturnType<Client["knownHosts"]["list"]>>["items"][number];
export type HostScan = Awaited<ReturnType<Client["knownHosts"]["scan"]>>;

/** The server name agents register Cockpit Context under in the snippets. */
const MCP_SERVER_NAME = "cockpit-context";

export const EXPIRY_CHOICES = ["d7", "d30", "d90", "y1", "never"] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
export const DEFAULT_EXPIRY: ExpiryChoice = "d90";

const EXPIRY_DAYS: Record<Exclude<ExpiryChoice, "never">, number> = {
  d7: 7,
  d30: 30,
  d90: 90,
  // 364, not 365: the server refuses an expiry more than 365 days ahead, and
  // the request takes a moment to arrive.
  y1: 364,
};

/** The expiry date for a choice, or null for a token that never expires. */
export function expiryFromChoice(choice: ExpiryChoice, now: number): Date | null {
  if (choice === "never") return null;
  return new Date(now + EXPIRY_DAYS[choice] * 86_400_000);
}

export interface ConnectionFlags {
  allowPropose: boolean;
  autoApprove: boolean;
}

/** Auto-approve only means something while proposing is allowed (the server applies the same rule). */
export function normalizeFlags(flags: ConnectionFlags): ConnectionFlags {
  return { allowPropose: flags.allowPropose, autoApprove: flags.allowPropose && flags.autoApprove };
}

export type ConsentCapability = "list" | "ask" | "propose" | "autoAdd";

/**
 * What the agent can do, derived from the flags the person is choosing so the
 * list never claims less than the grant allows: with auto-approve on, its
 * proposals become packages with no human review.
 */
export function consentCapabilities(flags: ConnectionFlags): ConsentCapability[] {
  const { allowPropose, autoApprove } = normalizeFlags(flags);
  const items: ConsentCapability[] = ["list", "ask"];
  if (autoApprove) items.push("autoAdd");
  else if (allowPropose) items.push("propose");
  return items;
}

/** Shell-quote one argument for a POSIX shell (single quotes unless it is plainly safe). */
function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Claude Code, OAuth: no token; `/mcp` → Authenticate opens the browser. */
export function claudeOAuthCommand(mcpUrl: string): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${shellArg(mcpUrl)}`;
}

/** Codex, OAuth: authenticate with the named server after registering it. */
export function codexOAuthCommand(mcpUrl: string): string {
  return `codex mcp add ${MCP_SERVER_NAME} --url ${shellArg(mcpUrl)}\ncodex mcp login ${MCP_SERVER_NAME}`;
}

/** Codex reads the token from its launching shell, not a literal config value. */
export function codexTokenCommand(mcpUrl: string, secret: string): string {
  return `export COCKPIT_CONTEXT_TOKEN=${shellArg(secret)}\ncodex mcp add ${MCP_SERVER_NAME} --url ${shellArg(mcpUrl)} --bearer-token-env-var COCKPIT_CONTEXT_TOKEN`;
}

/** Claude Code, API token. */
export function claudeTokenCommand(mcpUrl: string, secret: string): string {
  return `${claudeOAuthCommand(mcpUrl)} --header "Authorization: Bearer ${secret}"`;
}

/** The generic `mcpServers` JSON most MCP clients read. */
export function mcpJsonConfig(mcpUrl: string, secret: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: `Bearer ${secret}` },
        },
      },
    },
    null,
    2,
  );
}

/** Where to paste a deploy key, per git host. Docs links, opened in a new tab. */
export const DEPLOY_KEY_DOCS = [
  {
    host: "github",
    href: "https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#deploy-keys",
  },
  { host: "gitlab", href: "https://docs.gitlab.com/user/project/deploy_keys/" },
  {
    host: "bitbucket",
    // Atlassian folded the old add-access-keys page into a generic settings
    // page; the per-OS "repository access keys" article is the one that walks
    // through pasting a public key (Cockpit Context's keys live on a Linux server).
    href: "https://support.atlassian.com/bitbucket-cloud/docs/set-up-repository-access-keys-on-linux/",
  },
] as const;

export interface ScanTarget {
  host: string;
  port: number;
}

const HOST_PATTERN = /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i;

/**
 * Read what someone pastes into the host field: `git.example.com`,
 * `git.example.com:2222`, `git@git.example.com:team/repo.git` or
 * `ssh://git@git.example.com:2222/team/repo.git`. An explicit port wins over
 * the one in the field only for `ssh://` and `host:port`; scp-like
 * `user@host:path` has no port (the part after `:` is a path). Returns null
 * when no host can be read. The server validates the host again.
 */
export function parseScanTarget(input: string, fallbackPort: number): ScanTarget | null {
  let value = input.trim();
  if (value === "") return null;
  let port = fallbackPort;
  const ssh = /^ssh:\/\//i.test(value);
  // Host keys belong to SSH; an https:// (or any other) URL names no SSH host.
  if (!ssh && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  if (ssh) value = value.slice("ssh://".length).split("/")[0] ?? "";
  const at = value.lastIndexOf("@");
  const scpLike = !ssh && at !== -1;
  if (at !== -1) value = value.slice(at + 1);
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    const rest = value.slice(end + 1);
    const literal = value.slice(0, end + 1);
    if (!scpLike && /^:\d+$/.test(rest)) port = Number(rest.slice(1));
    value = literal;
  } else {
    const colon = value.indexOf(":");
    if (colon !== -1) {
      const rest = value.slice(colon + 1);
      if (!scpLike && /^\d+$/.test(rest)) port = Number(rest);
      value = value.slice(0, colon);
    }
    value = value.split("/")[0] ?? "";
  }
  value = value.toLowerCase();
  if (!HOST_PATTERN.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return { host: value, port };
}

/** `host` or `host:port` (non-default port, IPv6 already bracketed). */
export function hostLabel(host: string, port: number): string {
  return port === 22 ? host : `${host}:${port}`;
}

/** `/access/known-hosts?host=…&port=…`: a clone failure links here to confirm that host. */
export interface KnownHostsSearch {
  host?: string;
  port?: number;
}

export function parseKnownHostsSearch(search: Record<string, unknown>): KnownHostsSearch {
  const host = typeof search.host === "string" ? search.host.trim().slice(0, 253) : "";
  // The router JSON-parses search values, so `?port=2222` arrives as a number.
  const port = typeof search.port === "string" ? Number(search.port) : search.port;
  const validPort =
    typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;
  return {
    ...(host === "" ? {} : { host }),
    ...(host !== "" && validPort ? { port } : {}),
  };
}
