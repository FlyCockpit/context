import { readCapped } from "./npm-registry";
import { type Ecosystem, normalizePackageName } from "./package-names";
import { parseRemoteUrl } from "./remote-url";

/**
 * Registry lookup (`packages.lookupRegistry`, and `propose_dependency` filling
 * in what the agent left out; docs/product.md § Entities).
 *
 * Outbound HTTP goes only to the fixed registry hosts below, never to a
 * user-named host, with a 5 s timeout, no redirects and a size cap. The name
 * is validated by `normalizePackageName` before it is put into a URL. The
 * results are suggestions: the user (or the approve dialog) still supplies
 * the final values, and a suggested git URL is validated like any other when
 * the package is saved.
 */

const REGISTRY_URLS = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
  cargo: "https://crates.io",
  goProxy: "https://proxy.golang.org",
} as const;

const TIMEOUT_MS = 5_000;
/** crates.io and PyPI answers carry every release; big projects run to a few MB. */
const MAX_BYTES = 10 * 1024 * 1024;
/** crates.io refuses requests without a User-Agent (its crawler policy). */
const USER_AGENT = "cockpit-context/1.0.0 (+https://github.com/FlyCockpit/context)";
const WELL_KNOWN_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

export interface RegistrySuggestion {
  ecosystem: Ecosystem;
  /** The normalized registry name (`@tanstack/react-query`, `requests`). */
  name: string;
  displayName: string;
  /** An `https://` repository URL, or null when the registry names none we can use. */
  gitUrl: string | null;
  /** Monorepo package path (npm `repository.directory`, Go module subpaths). */
  subdirectory: string | null;
  latestVersion: string | null;
  homepage: string | null;
}

export type RegistryLookupResult =
  | { status: "found"; suggestion: RegistrySuggestion }
  /** The registry has no such package (or the name is not valid for the ecosystem). */
  | { status: "not_found" }
  /** Timeout, network failure, an unexpected status or an unreadable answer. */
  | { status: "unavailable" };

export interface RegistryLookupDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Keep a registry-supplied display value bounded; it is untrusted text. */
function clip(value: string | null, max = 200): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

const SHORTHAND_HOSTS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

/**
 * Turn whatever a registry calls a repository (`git+https://…/x.git`,
 * `git://…`, `git@github.com:o/r.git`, `github:o/r`, a GitHub `tree/main`
 * page) into a clean `https://host/path` URL, or `null`.
 *
 * - `allowShorthand` accepts npm's `o/r` and `github:o/r` forms.
 * - `wellKnownOnly` drops hosts other than GitHub, GitLab and Bitbucket
 *   (PyPI's project URLs point at docs sites as often as at code).
 */
export function normalizeRepositoryUrl(
  raw: string,
  options: { allowShorthand?: boolean; wellKnownOnly?: boolean } = {},
): string | null {
  let value = raw.trim();
  if (value.length === 0 || value.length > 2_000) return null;
  if (value.startsWith("git+")) value = value.slice(4);

  const shorthand = /^(?:(github|gitlab|bitbucket):)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(
    value,
  );
  if (shorthand && !value.includes("://")) {
    if (!options.allowShorthand) return null;
    const host = SHORTHAND_HOSTS[shorthand[1] ?? "github"];
    value = `https://${host}/${shorthand[2]}/${shorthand[3]}`;
  }

  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(value);
  if (scp && !value.includes("://")) value = `https://${scp[1]}/${scp[2]}`;

  let url: URL;
  try {
    url = new URL(value.replace(/^(?:git|ssh|http|git\+ssh):\/\//i, "https://"));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.length === 0) return null;
  const host = url.hostname.toLowerCase();
  if (options.wellKnownOnly && !WELL_KNOWN_HOSTS.has(host)) return null;

  let segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (host === "github.com" || host === "bitbucket.org") {
    segments = segments.slice(0, 2);
  } else if (host === "gitlab.com") {
    const dash = segments.indexOf("-");
    if (dash !== -1) segments = segments.slice(0, dash);
  }
  if (segments.length < 2 && WELL_KNOWN_HOSTS.has(host)) return null;
  if (segments.length === 0) return null;
  const last = segments.length - 1;
  segments[last] = (segments[last] ?? "").replace(/\.git$/i, "");
  if (segments[last] === "") return null;

  const port = url.port ? `:${url.port}` : "";
  const candidate = `https://${host}${port}/${segments.join("/")}`;
  try {
    // The git layer's own syntax rules (no userinfo, no private literals, …).
    parseRemoteUrl(candidate);
  } catch {
    return null;
  }
  return candidate;
}

function cleanSubdirectory(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return /^[A-Za-z0-9._@/+-]+$/.test(trimmed) ? trimmed : null;
}

/** npm `GET /<name>/latest`: the latest version's manifest. */
export function parseNpmManifest(body: unknown, name: string): RegistrySuggestion | null {
  const manifest = asRecord(body);
  if (!manifest) return null;
  const repository = manifest.repository;
  const repoRecord = asRecord(repository);
  const repoUrl = asString(repoRecord ? repoRecord.url : repository);
  return {
    ecosystem: "npm",
    name,
    displayName: clip(asString(manifest.name)) ?? name,
    gitUrl: repoUrl ? normalizeRepositoryUrl(repoUrl, { allowShorthand: true }) : null,
    subdirectory: cleanSubdirectory(asString(repoRecord?.directory)),
    latestVersion: clip(asString(manifest.version), 100),
    homepage: clip(asString(manifest.homepage), 500),
  };
}

/** Keys tried in order, compared lowercased with whitespace removed. */
const PYPI_URL_KEYS = ["source", "sourcecode", "repository", "code", "github", "homepage", "home"];

/** PyPI `GET /pypi/<name>/json`. */
export function parsePypiProject(body: unknown, name: string): RegistrySuggestion | null {
  const info = asRecord(asRecord(body)?.info);
  if (!info) return null;
  const urls = asRecord(info.project_urls) ?? {};
  const byKey = new Map<string, string>();
  for (const [key, value] of Object.entries(urls)) {
    const url = asString(value);
    if (url) byKey.set(key.toLowerCase().replace(/[\s_-]+/g, ""), url);
  }
  const candidates = [
    ...PYPI_URL_KEYS.map((key) => byKey.get(key)),
    asString(info.home_page),
    ...byKey.values(),
  ];
  let gitUrl: string | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    gitUrl = normalizeRepositoryUrl(candidate, { wellKnownOnly: true });
    if (gitUrl) break;
  }
  return {
    ecosystem: "pypi",
    name,
    displayName: clip(asString(info.name)) ?? name,
    gitUrl,
    subdirectory: null,
    latestVersion: clip(asString(info.version), 100),
    homepage: clip(asString(info.home_page) ?? byKey.get("homepage") ?? null, 500),
  };
}

/** crates.io `GET /api/v1/crates/<name>`. */
export function parseCratesCrate(body: unknown, name: string): RegistrySuggestion | null {
  const crate = asRecord(asRecord(body)?.crate);
  if (!crate) return null;
  const repository = asString(crate.repository);
  const homepage = asString(crate.homepage);
  const gitUrl =
    (repository ? normalizeRepositoryUrl(repository) : null) ??
    (homepage ? normalizeRepositoryUrl(homepage, { wellKnownOnly: true }) : null);
  return {
    ecosystem: "cargo",
    name,
    displayName: clip(asString(crate.name)) ?? name,
    gitUrl,
    subdirectory: null,
    latestVersion: clip(
      asString(crate.max_stable_version) ??
        asString(crate.newest_version) ??
        asString(crate.max_version),
      100,
    ),
    homepage: clip(homepage, 500),
  };
}

/** Go's major-version suffix (`/v2`), which names no directory in the repository. */
const GO_MAJOR_SUFFIX = /^v(?:[2-9]|[1-9][0-9]+)$/;

/**
 * What the module path itself says: `github.com/<o>/<r>[/<sub…>][/vN]` (and
 * Bitbucket) maps to the repository and a subdirectory. GitLab groups nest,
 * so only a two-segment GitLab path is unambiguous.
 */
export function goModuleRepository(
  modulePath: string,
): { gitUrl: string; subdirectory: string | null } | null {
  const elements = modulePath.split("/");
  const host = elements[0] ?? "";
  if (!WELL_KNOWN_HOSTS.has(host) || elements.length < 3) return null;
  if (host === "gitlab.com" && elements.length !== 3) return null;
  const rest = elements.slice(3);
  if (rest.length > 0 && GO_MAJOR_SUFFIX.test(rest[rest.length - 1] ?? "")) rest.pop();
  const gitUrl = normalizeRepositoryUrl(`https://${elements.slice(0, 3).join("/")}`);
  if (!gitUrl) return null;
  return { gitUrl, subdirectory: rest.length > 0 ? rest.join("/") : null };
}

/** proxy.golang.org `GET /<module>/@latest`: `{ Version, Origin?: { URL, Subdir } }`. */
export function parseGoLatest(
  body: unknown,
  modulePath: string,
): Pick<RegistrySuggestion, "latestVersion" | "gitUrl" | "subdirectory"> | null {
  const latest = asRecord(body);
  if (!latest) return null;
  const origin = asRecord(latest.Origin);
  const originUrl = asString(origin?.URL);
  const fromPath = goModuleRepository(modulePath);
  return {
    latestVersion: clip(asString(latest.Version), 100),
    gitUrl: fromPath?.gitUrl ?? (originUrl ? normalizeRepositoryUrl(originUrl) : null),
    subdirectory: fromPath
      ? fromPath.subdirectory
      : cleanSubdirectory(asString(origin?.Subdir) ?? null),
  };
}

/** The Go module proxy's case encoding: each uppercase letter becomes `!` + lowercase. */
export function escapeGoModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

export function registryRequestUrl(ecosystem: Exclude<Ecosystem, "git">, name: string): string {
  switch (ecosystem) {
    case "npm":
      return `${REGISTRY_URLS.npm}/${name.replace("/", "%2f")}/latest`;
    case "pypi":
      return `${REGISTRY_URLS.pypi}/pypi/${encodeURIComponent(name)}/json`;
    case "cargo":
      return `${REGISTRY_URLS.cargo}/api/v1/crates/${encodeURIComponent(name)}`;
    case "go":
      return `${REGISTRY_URLS.goProxy}/${escapeGoModulePath(name)}/@latest`;
  }
}

type Fetched =
  | { status: "ok"; body: unknown }
  | { status: "not_found" }
  | { status: "unavailable" };

async function fetchJson(url: string, deps: RegistryLookupDeps): Promise<Fetched> {
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 410) return { status: "not_found" };
    if (!response.ok) return { status: "unavailable" };
    const text = await readCapped(response, MAX_BYTES);
    if (text === null) return { status: "unavailable" };
    return { status: "ok", body: JSON.parse(text) };
  } catch {
    return { status: "unavailable" };
  }
}

/** Look a package up in its ecosystem's registry. `git` packages have no registry. */
export async function lookupRegistry(
  input: { ecosystem: Exclude<Ecosystem, "git">; name: string },
  deps: RegistryLookupDeps = {},
): Promise<RegistryLookupResult> {
  const name = normalizePackageName(input.ecosystem, input.name);
  if (name === null) return { status: "not_found" };
  const fetched = await fetchJson(registryRequestUrl(input.ecosystem, name), deps);

  if (input.ecosystem === "go") {
    // The module path alone can name the repository even when the proxy
    // does not know the module (or is unreachable).
    const fromPath = goModuleRepository(name);
    const latest = fetched.status === "ok" ? parseGoLatest(fetched.body, name) : null;
    if (!latest && !fromPath) {
      return fetched.status === "unavailable" ? fetched : { status: "not_found" };
    }
    return {
      status: "found",
      suggestion: {
        ecosystem: "go",
        name,
        displayName: name,
        gitUrl: latest?.gitUrl ?? fromPath?.gitUrl ?? null,
        subdirectory: latest ? latest.subdirectory : (fromPath?.subdirectory ?? null),
        latestVersion: latest?.latestVersion ?? null,
        homepage: null,
      },
    };
  }

  if (fetched.status !== "ok") return fetched;
  const parse =
    input.ecosystem === "npm"
      ? parseNpmManifest
      : input.ecosystem === "pypi"
        ? parsePypiProject
        : parseCratesCrate;
  const suggestion = parse(fetched.body, name);
  return suggestion ? { status: "found", suggestion } : { status: "unavailable" };
}
