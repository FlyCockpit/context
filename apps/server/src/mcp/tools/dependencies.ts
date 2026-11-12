import prisma, { type Prisma } from "@cockpit-context/db";
import { fromStoredEcosystem, parsePackageIdentifier } from "@cockpit-context/repos";
import { z } from "zod";

import { defineTool, McpToolError } from "./types";

/**
 * `list_dependencies` and the package lookup the other tools share. Every
 * query is scoped by the credential's user (`ownerId`); another user's
 * package simply does not exist here.
 */

/** Packages one listing returns: a dependency list, not a catalog. */
const LIST_DEPENDENCIES_LIMIT = 200;
const RECENT_VERSIONS = 5;
const CLOSE_MATCHES = 5;

const dependencySelect = {
  identifier: true,
  displayName: true,
  ecosystem: true,
  defaultRef: true,
  Repository: {
    select: {
      defaultBranch: true,
      Checkouts: {
        where: { status: "READY" },
        select: { sha: true, resolvedFrom: true, lastUsedAt: true },
        orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
        take: RECENT_VERSIONS,
      },
    },
  },
} satisfies Prisma.PackageSelect;

type DependencyRow = Prisma.PackageGetPayload<{ select: typeof dependencySelect }>;

function serializeDependency(row: DependencyRow) {
  return {
    identifier: row.identifier,
    display_name: row.displayName,
    ecosystem: fromStoredEcosystem(row.ecosystem),
    /** What a question with neither version nor ref reads: a ref, or the remote default branch. */
    default_ref: row.defaultRef ?? row.Repository?.defaultBranch ?? null,
    checked_out_versions: (row.Repository?.Checkouts ?? []).map((checkout) => ({
      resolved_from: checkout.resolvedFrom,
      sha: checkout.sha,
      last_used_at: checkout.lastUsedAt,
    })),
  };
}

export async function listDependencies(ownerId: string) {
  const rows = await prisma.package.findMany({
    where: { ownerId },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { identifier: "asc" }],
    take: LIST_DEPENDENCIES_LIMIT,
    select: dependencySelect,
  });
  return {
    dependencies: rows.map(serializeDependency),
    truncated: rows.length === LIST_DEPENDENCIES_LIMIT,
  };
}

/** Edit distance, bounded by the shorter string's length plus one row. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The owned identifiers closest to what the agent asked for: substring
 * matches on the name first, then by edit distance.
 */
export function closeMatches(wanted: string, identifiers: readonly string[]): string[] {
  const needle = wanted.toLowerCase();
  const bare = needle.includes(":") ? needle.slice(needle.indexOf(":") + 1) : needle;
  const maxDistance = Math.max(3, Math.floor(bare.length / 2));
  return identifiers
    .map((identifier) => {
      const lower = identifier.toLowerCase();
      const name = lower.slice(lower.indexOf(":") + 1);
      // Exact, then prefix, then substring matches, then by edit distance.
      if (name === bare) return { identifier, score: 0 };
      if (name.startsWith(bare) || bare.startsWith(name)) return { identifier, score: 1 };
      if (name.includes(bare) || bare.includes(name)) return { identifier, score: 2 };
      const distance = levenshtein(bare, name);
      return {
        identifier,
        score: distance <= maxDistance ? 3 + distance : Number.POSITIVE_INFINITY,
      };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.identifier.localeCompare(b.identifier))
    .slice(0, CLOSE_MATCHES)
    .map((entry) => entry.identifier);
}

/**
 * The caller's package for an identifier, or a `PACKAGE_NOT_FOUND` refusal
 * that lists close matches and says how to get the package added.
 */
export async function findOwnedPackage(
  ownerId: string,
  identifier: string,
  { allowPropose }: { allowPropose: boolean },
): Promise<{ id: string; identifier: string }> {
  const parsed = parsePackageIdentifier(identifier.trim());
  if (parsed) {
    const found = await prisma.package.findFirst({
      where: { ownerId, identifier: parsed.identifier },
      select: { id: true, identifier: true },
    });
    if (found) return found;
  }
  const owned = await prisma.package.findMany({
    where: { ownerId },
    select: { identifier: true },
    orderBy: { identifier: "asc" },
    take: LIST_DEPENDENCIES_LIMIT,
  });
  const matches = closeMatches(
    identifier,
    owned.map((row) => row.identifier),
  );
  const hint = allowPropose
    ? "If it is a dependency the user's project needs, call propose_dependency so the user can add it."
    : "Ask the user to add it in Cockpit Context.";
  const lead = parsed
    ? `No dependency named ${parsed.identifier} is in this user's Cockpit Context list.`
    : `"${identifier.slice(0, 200)}" is not a dependency identifier (expected <ecosystem>:<name>, for example npm:react).`;
  const suggestions = matches.length > 0 ? ` Close matches: ${matches.join(", ")}.` : "";
  throw new McpToolError(
    "PACKAGE_NOT_FOUND",
    `${lead}${suggestions} Call list_dependencies to see every identifier. ${hint}`,
    { close_matches: matches },
  );
}

export const listDependenciesTool = defineTool({
  name: "list_dependencies",
  description: [
    "List the dependencies this Cockpit Context user has set up for investigation.",
    "Call this first: the `identifier` of each entry (for example `npm:@tanstack/react-query`) is what query_dependency takes.",
    "`checked_out_versions` shows versions that are already checked out and answer fastest.",
  ].join(" "),
  input: z.object({}),
  run: async (_input, ctx) => listDependencies(ctx.identity.userId),
});
