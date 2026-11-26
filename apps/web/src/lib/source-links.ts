/**
 * Links from an answer's file citations (`src/router.ts:44-58`) and from the
 * conversation's commit to the public repository page at that exact commit.
 *
 * Only public `https://github.com/<owner>/<repo>` and
 * `https://gitlab.com/<group…>/<repo>` sources are linkable: any other host,
 * scheme or SSH form, a URL carrying credentials, a port, a query or a
 * fragment, or a path that is not a plain repository path gives no links at
 * all (the answer renders exactly as text). Cited paths are relative to the
 * checkout root (the explore tools' root is the whole worktree, not the
 * package's subdirectory), which is also the repository root.
 */

/** A cited file, optionally with a 1-based line or inclusive line range. */
interface FileReference {
  path: string;
  start?: number;
  end?: number;
}

export interface SourceLinks {
  /** The commit's page. */
  commit: string;
  /** The file (and lines) at the commit. */
  file: (ref: FileReference) => string;
}

type Host = "github" | "gitlab";

const HOSTS: Record<string, Host> = { "github.com": "github", "gitlab.com": "gitlab" };

/** One owner, group or project name (never GitLab's `-` route separator). */
const REPO_SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A repository URL's host and path segments, or null when it is not a plain public https repository. */
function parseRepository(sourceUrl: string): { host: Host; segments: string[] } | null {
  // `URL` would quietly turn `\` into `/` and drop whitespace; refuse them outright.
  if (!/^https:\/\/[^\s\\?#]+$/i.test(sourceUrl)) return null;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = HOSTS[url.hostname];
  if (!host) return null;
  let path = url.pathname.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  const segments = path.split("/").slice(1);
  if (segments.some((segment) => !REPO_SEGMENT.test(segment) || /^\.+$/.test(segment))) {
    return null;
  }
  if (host === "github" ? segments.length !== 2 : segments.length < 2) return null;
  return { host, segments };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Link builders for a conversation's source at `commitSha`, or null when
 * either is missing or not linkable (see the module comment).
 */
export function sourceLinks(
  sourceUrl: string | null | undefined,
  commitSha: string | null | undefined,
): SourceLinks | null {
  if (!sourceUrl || !commitSha) return null;
  const sha = commitSha.toLowerCase();
  if (!FULL_SHA.test(sha)) return null;
  const repository = parseRepository(sourceUrl);
  if (!repository) return null;
  const base = `https://${repository.host}.com/${repository.segments.join("/")}`;
  const sep = repository.host === "gitlab" ? "/-" : "";
  return {
    commit: `${base}${sep}/commit/${sha}`,
    file: ({ path, start, end }) => {
      let fragment = "";
      if (start !== undefined) {
        fragment = `#L${start}`;
        if (end !== undefined && end !== start) {
          fragment += repository.host === "github" ? `-L${end}` : `-${end}`;
        }
      }
      return `${base}${sep}/blob/${sha}/${encodePath(path)}${fragment}`;
    },
  };
}

/** Extensions a slash-less citation must have (`console.log` and `z.object` are not files). */
const BARE_FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "cts",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "lock",
  "md",
  "mdx",
  "mjs",
  "mod",
  "mts",
  "php",
  "py",
  "pyi",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "yaml",
  "yml",
  "zig",
]);

const REFERENCE = /^(?<path>[\w@.+~$\-[\]()=,!/]+?)(?::(?<start>\d{1,7})(?:-(?<end>\d{1,7}))?)?$/;
const PATH_SEGMENT = /^[\w@.+~$\-[\]()=,!]+$/;

/**
 * The file an inline code span cites — a relative path with a `/` or a file
 * extension, optionally followed by `:line` or `:start-end` — or null.
 * Absolute paths, `..`, URLs, empty segments and anything else stay text.
 */
export function parseFileReference(text: string): FileReference | null {
  const match = REFERENCE.exec(text);
  if (!match?.groups) return null;
  let path = match.groups.path ?? "";
  if (path.startsWith("./")) path = path.slice(2);
  if (path.endsWith("/")) path = path.slice(0, -1);
  const segments = path.split("/");
  if (!path || segments.some((segment) => !PATH_SEGMENT.test(segment) || /^\.+$/.test(segment))) {
    return null;
  }
  const name = segments.at(-1) ?? "";
  const extension = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(name)?.[1];
  const hasLines = match.groups.start !== undefined;
  const isFile =
    segments.length > 1
      ? extension !== undefined || hasLines
      : extension !== undefined && BARE_FILE_EXTENSIONS.has(extension.toLowerCase());
  if (!isFile) return null;
  if (!hasLines) return { path };
  const start = Number(match.groups.start);
  const end = match.groups.end === undefined ? undefined : Number(match.groups.end);
  if (start < 1 || (end !== undefined && end < start)) return null;
  return end === undefined || end === start ? { path, start } : { path, start, end };
}
