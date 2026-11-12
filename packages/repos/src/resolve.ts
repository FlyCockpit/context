import { RepoError } from "./errors";
import { GitCommandError, revParseCommit, runGit } from "./git-exec";
import { compareSemver, parseSemver, type SemVer } from "./semver";

/**
 * Version and ref resolution (docs/product.md). Pure over a small `RepoRefs` interface so tests can run it
 * against a real fixture repository with fake fetches.
 */

export type ResolvedFrom = `tag:${string}` | `branch:${string}` | "commit" | "npm-gitHead";

export interface Resolution {
  sha: string;
  resolvedFrom: ResolvedFrom;
}

/** The package fields resolution reads. */
export interface ResolvablePackage {
  ecosystem: "NPM" | "PYPI" | "CARGO" | "GO" | "GIT";
  /** Registry name without the ecosystem prefix, e.g. `@tanstack/react-query`. */
  name: string;
  tagPattern: string | null;
  defaultRef: string | null;
}

export interface ResolveInput {
  version?: string | null;
  ref?: string | null;
}

/** What resolution needs from a repository. */
export interface RepoRefs {
  /** Full SHA of `<rev>^{commit}`, or null. */
  revParse(rev: string): Promise<string | null>;
  /** Every tag name (bounded by the caller's output cap). */
  listTags(): Promise<string[]>;
  /** The default branch name, or null for an empty repository. */
  defaultBranch(): Promise<string | null>;
  /** Fetch branches when the last fetch is older than COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS. */
  fetchIfStale(): Promise<void>;
  /** `git fetch --tags`; called at most once per resolution. */
  fetchTags(): Promise<void>;
  /**
   * Fetch one full commit id missing from the clone (pinned, like every
   * fetch); local git calls never reach the remote themselves. Optional: a
   * resolver without it only sees local commits.
   */
  fetchCommit?(sha: string): Promise<void>;
}

export interface ResolveDeps {
  /** npm only: the registry's `gitHead` for `name@version`, or null. */
  npmGitHead?: (name: string, version: string) => Promise<string | null>;
}

const MAX_REF_LENGTH = 200;
const MAX_TAGS = 50_000;
const NEAREST_TAG_COUNT = 10;
const HEX_COMMIT = /^[0-9a-f]{7,40}$/i;
const FULL_COMMIT = /^[0-9a-f]{40}$/i;

/**
 * Refs we hand to git: git's own ref-name rules, plus never option-like and a
 * conservative character set. Refs only ever reach git after `refs/tags/`,
 * `refs/heads/` or `--end-of-options`, so this is defense in depth.
 */
export function isSafeRefName(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= MAX_REF_LENGTH &&
    /^[A-Za-z0-9._/@+-]+$/.test(ref) &&
    !ref.startsWith("-") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    !ref.endsWith(".lock") &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.includes("@{") &&
    !ref.split("/").some((part) => part.startsWith("."))
  );
}

function assertRef(ref: string): string {
  const trimmed = ref.trim();
  if (!isSafeRefName(trimmed)) {
    throw new RepoError("INVALID_REF", "That ref is not a valid tag, branch or commit name.");
  }
  return trimmed;
}

function assertVersion(version: string): string {
  const trimmed = version.trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,99}$/.test(trimmed)) {
    throw new RepoError("INVALID_REF", "That version string is not valid.");
  }
  return trimmed;
}

/** `name` and its last path segment (`@tanstack/react-query` → `react-query`), deduplicated. */
function nameVariants(name: string): string[] {
  const last = name.split("/").at(-1) ?? "";
  return [...new Set([name, last].filter((value) => value.length > 0))];
}

type TagTemplate = { template: string; specific: boolean };

function tagTemplates(pkg: ResolvablePackage): TagTemplate[] {
  const templates: TagTemplate[] = [];
  if (pkg.tagPattern?.includes("{version}")) {
    templates.push({ template: pkg.tagPattern, specific: true });
  }
  templates.push(
    { template: "v{version}", specific: false },
    { template: "{version}", specific: false },
  );
  for (const name of nameVariants(pkg.name)) {
    templates.push(
      { template: `${name}@{version}`, specific: true },
      { template: `${name}-v{version}`, specific: true },
    );
  }
  templates.push({ template: "release-{version}", specific: false });
  return templates;
}

/** Candidate tag names for `version`, in the order they are tried. */
export function versionTagCandidates(pkg: ResolvablePackage, version: string): string[] {
  const out = tagTemplates(pkg).map(({ template }) => template.replaceAll("{version}", version));
  return [...new Set(out)].filter(isSafeRefName);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateRegExp(template: string): RegExp {
  const [before = "", ...rest] = template.split("{version}");
  const after = rest.join("{version}");
  return new RegExp(`^${escapeRegExp(before)}(.+)${escapeRegExp(after)}$`);
}

/**
 * Up to 10 tags near `version`, semver-sorted (highest first), filtered by the
 * package's naming pattern: package-specific templates (tagPattern,
 * `name@`, `name-v`) when any tag matches them, otherwise the generic ones.
 */
export function nearestTags(
  tags: readonly string[],
  pkg: ResolvablePackage,
  version: string,
): string[] {
  const templates = tagTemplates(pkg);
  const collect = (specific: boolean) => {
    const regexes = templates
      .filter((t) => t.specific === specific)
      .map((t) => templateRegExp(t.template));
    const out: { tag: string; semver: SemVer }[] = [];
    for (const tag of tags) {
      for (const regex of regexes) {
        const captured = regex.exec(tag)?.[1];
        const semver = captured ? parseSemver(captured) : null;
        if (semver) {
          out.push({ tag, semver });
          break;
        }
      }
    }
    return out;
  };
  const specific = collect(true);
  const matched = specific.length > 0 ? specific : collect(false);
  matched.sort((a, b) => compareSemver(a.semver, b.semver) || (a.tag < b.tag ? -1 : 1));
  const target = parseSemver(version);
  let start = Math.max(0, matched.length - NEAREST_TAG_COUNT);
  if (target) {
    let index = matched.findIndex((entry) => compareSemver(entry.semver, target) >= 0);
    if (index === -1) index = matched.length;
    start = Math.min(
      Math.max(0, index - NEAREST_TAG_COUNT / 2),
      Math.max(0, matched.length - NEAREST_TAG_COUNT),
    );
  }
  return matched
    .slice(start, start + NEAREST_TAG_COUNT)
    .map((entry) => entry.tag)
    .reverse();
}

/**
 * `revParse`, plus one explicit fetch when a full commit id is missing from
 * the clone (it may exist only on the server: an unadvertised ref, or not
 * fetched yet). Abbreviated ids only ever match local objects.
 */
async function revParseCommitOrFetch(refs: RepoRefs, rev: string): Promise<string | null> {
  const local = await refs.revParse(rev);
  if (local || !FULL_COMMIT.test(rev) || !refs.fetchCommit) return local;
  await refs.fetchCommit(rev.toLowerCase());
  return refs.revParse(rev);
}

async function resolveRefName(refs: RepoRefs, rawRef: string): Promise<Resolution> {
  const ref = assertRef(rawRef);
  const tag = async (): Promise<Resolution | null> => {
    const sha = await refs.revParse(`refs/tags/${ref}`);
    return sha ? { sha, resolvedFrom: `tag:${ref}` } : null;
  };
  const branch = async (): Promise<Resolution | null> => {
    const sha = await refs.revParse(`refs/heads/${ref}`);
    return sha ? { sha, resolvedFrom: `branch:${ref}` } : null;
  };
  const commit = async (): Promise<Resolution | null> => {
    if (!HEX_COMMIT.test(ref)) return null;
    const sha = await revParseCommitOrFetch(refs, ref.toLowerCase());
    return sha ? { sha, resolvedFrom: "commit" } : null;
  };

  // A present tag is immutable: no fetch.
  const presentTag = await tag();
  if (presentTag) return presentTag;
  // So is a full commit id: in the clone, or fetched by id when it is not.
  // (Abbreviated hex could still be a branch name, so it keeps the
  // branch-first order.)
  if (FULL_COMMIT.test(ref)) {
    const presentCommit = await commit();
    if (presentCommit) return presentCommit;
  }
  // Branches move: fetch first when the last fetch is stale.
  await refs.fetchIfStale();
  const found = (await branch()) ?? (await tag()) ?? (await commit());
  if (found) return found;
  // A missing tag (or a commit only reachable from one) gets one tag fetch.
  await refs.fetchTags();
  const afterTags = (await tag()) ?? (await branch()) ?? (await commit());
  if (afterTags) return afterTags;
  throw new RepoError(
    "REF_NOT_FOUND",
    `No tag, branch or commit named "${ref}" exists in the repository.`,
  );
}

async function resolveVersion(
  refs: RepoRefs,
  pkg: ResolvablePackage,
  rawVersion: string,
  deps: ResolveDeps,
): Promise<Resolution> {
  const version = assertVersion(rawVersion);
  const candidates = versionTagCandidates(pkg, version);
  const tryTags = async (): Promise<Resolution | null> => {
    for (const candidate of candidates) {
      const sha = await refs.revParse(`refs/tags/${candidate}`);
      if (sha) return { sha, resolvedFrom: `tag:${candidate}` };
    }
    return null;
  };

  const present = await tryTags();
  if (present) return present;
  await refs.fetchTags();
  const fetched = await tryTags();
  if (fetched) return fetched;

  if (pkg.ecosystem === "NPM" && deps.npmGitHead) {
    const gitHead = await deps.npmGitHead(pkg.name, version);
    if (gitHead) {
      const sha = await revParseCommitOrFetch(refs, gitHead);
      if (sha) return { sha, resolvedFrom: "npm-gitHead" };
    }
  }

  const tags = (await refs.listTags()).slice(0, MAX_TAGS);
  const suggestions = nearestTags(tags, pkg, version);
  throw new RepoError(
    "VERSION_NOT_FOUND",
    `No tag matches version ${version} (tried ${candidates.join(", ")}). Pass a ref instead.`,
    { nearestTags: suggestions },
  );
}

/**
 * Resolve `version` or `ref` (mutually exclusive) to a commit. Neither means
 * the package's `defaultRef`, else the repository's default branch.
 */
export async function resolveInRepo(
  refs: RepoRefs,
  pkg: ResolvablePackage,
  input: ResolveInput,
  deps: ResolveDeps = {},
): Promise<Resolution> {
  const version = input.version?.trim() || null;
  const ref = input.ref?.trim() || null;
  if (version && ref) {
    throw new RepoError("INVALID_REF", "Pass either a version or a ref, not both.");
  }
  if (ref) return resolveRefName(refs, ref);
  if (version) return resolveVersion(refs, pkg, version, deps);
  if (pkg.defaultRef) return resolveRefName(refs, pkg.defaultRef);

  await refs.fetchIfStale();
  const branch = await refs.defaultBranch();
  if (branch) {
    const sha = await refs.revParse(`refs/heads/${branch}`);
    if (sha) return { sha, resolvedFrom: `branch:${branch}` };
  }
  throw new RepoError("REF_NOT_FOUND", "The repository has no default branch to resolve.");
}

/** `RepoRefs` over a bare repository on disk; fetches are supplied by the caller. */
export function bareRepoRefs(
  gitDir: string,
  fetchers: Pick<RepoRefs, "fetchIfStale" | "fetchTags" | "fetchCommit">,
): RepoRefs {
  let fetchedTags = false;
  const fetchedCommits = new Set<string>();
  const fetchCommit = fetchers.fetchCommit;
  return {
    // At most one fetch per commit id per resolution.
    ...(fetchCommit
      ? {
          async fetchCommit(sha: string) {
            if (fetchedCommits.has(sha)) return;
            fetchedCommits.add(sha);
            await fetchCommit(sha);
          },
        }
      : {}),
    revParse: (rev) => revParseCommit(gitDir, rev),
    async listTags() {
      const { stdout } = await runGit(
        ["for-each-ref", "--format=%(refname:strip=2)", "refs/tags"],
        {
          gitDir,
        },
      );
      return stdout.split("\n").filter((line) => line.length > 0);
    },
    defaultBranch: () => readDefaultBranch(gitDir),
    fetchIfStale: () => fetchers.fetchIfStale(),
    async fetchTags() {
      if (fetchedTags) return;
      fetchedTags = true;
      await fetchers.fetchTags();
    },
  };
}

/** `HEAD` of a bare repository as a branch name, or null when unborn/detached. */
export async function readDefaultBranch(gitDir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["symbolic-ref", "--quiet", "HEAD"], { gitDir });
    const ref = stdout.trim();
    if (!ref.startsWith("refs/heads/")) return null;
    const branch = ref.slice("refs/heads/".length);
    if (!isSafeRefName(branch)) return null;
    const sha = await revParseCommit(gitDir, ref);
    return sha ? branch : null;
  } catch (error) {
    if (error instanceof GitCommandError && error.code === "GIT_FAILED") return null;
    throw error;
  }
}
