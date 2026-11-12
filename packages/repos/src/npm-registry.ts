/**
 * npm `gitHead` lookup: the commit a version was published from, used when no
 * tag matches (docs/product.md). Outbound HTTP to the fixed public registry only; best effort — any
 * failure means "no gitHead", and resolution falls through to its error.
 */

const NPM_REGISTRY_URL = "https://registry.npmjs.org";

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export interface NpmRegistryDeps {
  fetch?: typeof fetch;
  registryUrl?: string;
  timeoutMs?: number;
}

/** The registry path for `name@version` (`@scope/pkg` → `@scope%2fpkg`). */
export function npmVersionUrl(
  name: string,
  version: string,
  registryUrl = NPM_REGISTRY_URL,
): string {
  return `${registryUrl}/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`;
}

/**
 * Read a response body as UTF-8, or `null` once it would exceed `maxBytes`
 * (checked against `content-length` first, then while streaming).
 */
export async function readCapped(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchNpmGitHead(
  name: string,
  version: string,
  deps: NpmRegistryDeps = {},
): Promise<string | null> {
  if (!NPM_NAME.test(name) || name.length > 214) return null;
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const response = await fetchImpl(npmVersionUrl(name, version, deps.registryUrl), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await readCapped(response);
    if (text === null) return null;
    const body: unknown = JSON.parse(text);
    const gitHead =
      typeof body === "object" && body !== null
        ? (body as { gitHead?: unknown }).gitHead
        : undefined;
    return typeof gitHead === "string" && /^[0-9a-f]{40}$/.test(gitHead) ? gitHead : null;
  } catch {
    return null;
  }
}
