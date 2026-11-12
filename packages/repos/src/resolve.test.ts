import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RepoError } from "./errors";
import {
  bareRepoRefs,
  isSafeRefName,
  nearestTags,
  type ResolvablePackage,
  readDefaultBranch,
  resolveInRepo,
  versionTagCandidates,
} from "./resolve";
import { createFixtureRepo, type FixtureRepo, fixtureGit } from "./test-support/fixture-repo";

const npmPackage: ResolvablePackage = {
  ecosystem: "NPM",
  name: "@scope/pkg",
  tagPattern: null,
  defaultRef: null,
};

let root: string;
let fixture: FixtureRepo;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cockpit-context-resolve-"));
  fixture = await createFixtureRepo(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const fetchIfStale = vi.fn(async () => {});
const fetchTags = vi.fn(async () => {});

function refs() {
  return bareRepoRefs(fixture.bareDir, { fetchIfStale, fetchTags });
}

beforeEach(() => {
  fetchIfStale.mockReset().mockResolvedValue(undefined);
  fetchTags.mockReset().mockResolvedValue(undefined);
});

describe("versionTagCandidates", () => {
  it("tries tagPattern, v-prefix, bare, monorepo names, then release-", () => {
    expect(
      versionTagCandidates(
        {
          ecosystem: "NPM",
          name: "@tanstack/react-query",
          tagPattern: "rq-{version}",
          defaultRef: null,
        },
        "5.2.0",
      ),
    ).toEqual([
      "rq-5.2.0",
      "v5.2.0",
      "5.2.0",
      "@tanstack/react-query@5.2.0",
      "@tanstack/react-query-v5.2.0",
      "react-query@5.2.0",
      "react-query-v5.2.0",
      "release-5.2.0",
    ]);
  });
});

describe("isSafeRefName", () => {
  it.each(["main", "v1.0.0", "feature/x", "@scope/pkg@1.0.0", "release-4.0.0", "abc1234"])(
    "accepts %s",
    (ref) => {
      expect(isSafeRefName(ref)).toBe(true);
    },
  );

  it.each([
    "-x",
    "--upload-pack=evil",
    "a..b",
    "a//b",
    "a@{1}",
    "/a",
    "a/",
    "a.lock",
    "a/.b",
    "a b",
    "a~1",
    "a^",
    ":/x",
    "",
  ])("rejects %s", (ref) => {
    expect(isSafeRefName(ref)).toBe(false);
  });
});

describe("nearestTags", () => {
  const tags = [
    "v1.0.0",
    "v1.1.0",
    "v1.2.0",
    "v2.0.0",
    "v2.1.0",
    "v2.2.0",
    "v3.0.0",
    "v3.1.0",
    "v4.0.0",
    "v4.1.0",
    "v5.0.0",
    "v5.1.0",
    "nightly",
  ];

  it("returns up to 10 tags around the version, highest first", () => {
    const result = nearestTags(tags, { ...npmPackage, name: "x" }, "3.0.5");
    expect(result).toHaveLength(10);
    expect(result[0]).toBe("v5.1.0");
    expect(result.at(-1)).toBe("v1.2.0");
    expect(result).toContain("v3.0.0");
    expect(result).toContain("v3.1.0");
    expect(result).not.toContain("nightly");
  });

  it("prefers the package's own naming pattern in a monorepo", () => {
    const monorepo = ["@scope/pkg@1.0.0", "@scope/pkg@1.1.0", "@scope/other@9.9.9", "v7.0.0"];
    expect(nearestTags(monorepo, npmPackage, "1.0.5")).toEqual([
      "@scope/pkg@1.1.0",
      "@scope/pkg@1.0.0",
    ]);
  });
});

describe("resolveInRepo", () => {
  it("resolves a ref naming a tag without fetching", async () => {
    await expect(resolveInRepo(refs(), npmPackage, { ref: "v1.0.0" })).resolves.toEqual({
      sha: fixture.shas.one,
      resolvedFrom: "tag:v1.0.0",
    });
    expect(fetchIfStale).not.toHaveBeenCalled();
    expect(fetchTags).not.toHaveBeenCalled();
  });

  it("resolves a branch after the staleness fetch", async () => {
    await expect(resolveInRepo(refs(), npmPackage, { ref: "feature" })).resolves.toEqual({
      sha: fixture.shas.feature,
      resolvedFrom: "branch:feature",
    });
    expect(fetchIfStale).toHaveBeenCalledOnce();
  });

  it("resolves full and abbreviated commit SHAs", async () => {
    await expect(resolveInRepo(refs(), npmPackage, { ref: fixture.shas.two })).resolves.toEqual({
      sha: fixture.shas.two,
      resolvedFrom: "commit",
    });
    await expect(
      resolveInRepo(refs(), npmPackage, { ref: fixture.shas.two.slice(0, 10).toUpperCase() }),
    ).resolves.toEqual({ sha: fixture.shas.two, resolvedFrom: "commit" });
  });

  it("does not fetch for a full commit SHA already in the clone", async () => {
    await expect(resolveInRepo(refs(), npmPackage, { ref: fixture.shas.two })).resolves.toEqual({
      sha: fixture.shas.two,
      resolvedFrom: "commit",
    });
    expect(fetchIfStale).not.toHaveBeenCalled();
    expect(fetchTags).not.toHaveBeenCalled();
  });

  it("fetches a full commit id missing from the clone once, by id, then resolves it", async () => {
    // Reachable only from an unadvertised ref the clone never fetches.
    const tree = await fixtureGit(fixture.workDir, "rev-parse", `${fixture.shas.four}^{tree}`);
    const prSha = await fixtureGit(
      fixture.workDir,
      "commit-tree",
      tree,
      "-p",
      fixture.shas.four,
      "-m",
      "pr",
    );
    await fixtureGit(fixture.workDir, "update-ref", "refs/pull/1/head", prSha);
    const fetchCommit = vi.fn(async (sha: string) => {
      await fixtureGit(fixture.bareDir, "fetch", "--quiet", "origin", sha);
    });
    const withFetch = () => bareRepoRefs(fixture.bareDir, { fetchIfStale, fetchTags, fetchCommit });
    await expect(resolveInRepo(withFetch(), npmPackage, { ref: prSha })).resolves.toEqual({
      sha: prSha,
      resolvedFrom: "commit",
    });
    expect(fetchCommit).toHaveBeenCalledExactlyOnceWith(prSha);
    expect(fetchIfStale).not.toHaveBeenCalled();
    expect(fetchTags).not.toHaveBeenCalled();

    // A commit nobody has: one fetch attempt per resolution, then REF_NOT_FOUND.
    fetchCommit.mockReset().mockResolvedValue(undefined);
    await expect(
      resolveInRepo(withFetch(), npmPackage, { ref: "e".repeat(40) }),
    ).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(fetchCommit).toHaveBeenCalledOnce();

    // Abbreviated ids only ever match local objects.
    fetchCommit.mockClear();
    await expect(
      resolveInRepo(withFetch(), npmPackage, { ref: "e".repeat(12) }),
    ).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(fetchCommit).not.toHaveBeenCalled();
  });

  it("fetches a missing npm gitHead commit by id", async () => {
    const tree = await fixtureGit(fixture.workDir, "rev-parse", `${fixture.shas.two}^{tree}`);
    const published = await fixtureGit(fixture.workDir, "commit-tree", tree, "-m", "published");
    await fixtureGit(fixture.workDir, "update-ref", "refs/pull/2/head", published);
    const fetchCommit = vi.fn(async (sha: string) => {
      await fixtureGit(fixture.bareDir, "fetch", "--quiet", "origin", sha);
    });
    await expect(
      resolveInRepo(
        bareRepoRefs(fixture.bareDir, { fetchIfStale, fetchTags, fetchCommit }),
        npmPackage,
        { version: "8.8.8" },
        { npmGitHead: async () => published },
      ),
    ).resolves.toEqual({ sha: published, resolvedFrom: "npm-gitHead" });
    expect(fetchCommit).toHaveBeenCalledExactlyOnceWith(published);
  });

  it("refuses option-like refs before reaching git", async () => {
    await expect(
      resolveInRepo(refs(), npmPackage, { ref: "--output=/tmp/x" }),
    ).rejects.toMatchObject({
      code: "INVALID_REF",
    });
  });

  it("refuses version and ref together", async () => {
    await expect(
      resolveInRepo(refs(), npmPackage, { ref: "main", version: "1.0.0" }),
    ).rejects.toMatchObject({
      code: "INVALID_REF",
    });
  });

  it.each([
    ["1.0.0", "tag:v1.0.0", "one"],
    ["1.1.0", "tag:1.1.0", "one"],
    ["2.0.0", "tag:@scope/pkg@2.0.0", "two"],
    ["2.1.0", "tag:pkg-v2.1.0", "two"],
    ["4.0.0", "tag:release-4.0.0", "two"],
    ["5.0.0-beta.1", "tag:v5.0.0-beta.1", "two"],
  ] as const)("resolves version %s via %s", async (version, resolvedFrom, commit) => {
    await expect(resolveInRepo(refs(), npmPackage, { version })).resolves.toEqual({
      sha: fixture.shas[commit],
      resolvedFrom,
    });
    expect(fetchTags).not.toHaveBeenCalled();
  });

  it("uses the last path segment for monorepo tags", async () => {
    await expect(
      resolveInRepo(refs(), { ...npmPackage, name: "@tanstack/react-query" }, { version: "3.0.0" }),
    ).resolves.toEqual({ sha: fixture.shas.two, resolvedFrom: "tag:react-query@3.0.0" });
  });

  it("tries the tagPattern first", async () => {
    await expect(
      resolveInRepo(
        refs(),
        { ...npmPackage, tagPattern: "release-{version}" },
        { version: "4.0.0" },
      ),
    ).resolves.toEqual({ sha: fixture.shas.two, resolvedFrom: "tag:release-4.0.0" });
  });

  it("fetches tags once when a version's tag is missing, then finds it", async () => {
    await fixtureGit(fixture.workDir, "tag", "v6.0.0", fixture.shas.four);
    fetchTags.mockImplementation(async () => {
      await fixtureGit(fixture.bareDir, "fetch", "--quiet", "--tags", "origin");
    });
    await expect(resolveInRepo(refs(), npmPackage, { version: "6.0.0" })).resolves.toEqual({
      sha: fixture.shas.four,
      resolvedFrom: "tag:v6.0.0",
    });
    expect(fetchTags).toHaveBeenCalledOnce();
  });

  it("falls back to the npm gitHead when no tag matches", async () => {
    const npmGitHead = vi.fn(async () => fixture.shas.feature);
    await expect(
      resolveInRepo(refs(), npmPackage, { version: "9.9.9" }, { npmGitHead }),
    ).resolves.toEqual({
      sha: fixture.shas.feature,
      resolvedFrom: "npm-gitHead",
    });
    expect(npmGitHead).toHaveBeenCalledWith("@scope/pkg", "9.9.9");
  });

  it("does not consult npm for other ecosystems", async () => {
    const npmGitHead = vi.fn(async () => fixture.shas.feature);
    await expect(
      resolveInRepo(
        refs(),
        { ...npmPackage, ecosystem: "PYPI", name: "pkg" },
        { version: "9.9.9" },
        { npmGitHead },
      ),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    expect(npmGitHead).not.toHaveBeenCalled();
  });

  it("reports the nearest tags when nothing matches", async () => {
    const npmGitHead = vi.fn(async () => "0".repeat(40));
    const error = await resolveInRepo(
      refs(),
      { ...npmPackage, name: "plain" },
      { version: "1.1.5" },
      { npmGitHead },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RepoError);
    expect(error).toMatchObject({ code: "VERSION_NOT_FOUND" });
    const nearest = (error as RepoError).details.nearestTags ?? [];
    expect(nearest).toContain("1.1.0");
    expect(nearest).toContain("v1.2.0");
    expect(nearest).not.toContain("@scope/pkg@2.0.0");
    expect(fetchTags).toHaveBeenCalledOnce();
  });

  it("reports a ref that matches nothing after fetching", async () => {
    await expect(
      resolveInRepo(refs(), npmPackage, { ref: "no-such-branch" }),
    ).rejects.toMatchObject({
      code: "REF_NOT_FOUND",
    });
    expect(fetchIfStale).toHaveBeenCalledOnce();
    expect(fetchTags).toHaveBeenCalledOnce();
  });

  it("uses defaultRef, then the default branch", async () => {
    await expect(
      resolveInRepo(refs(), { ...npmPackage, defaultRef: "feature" }, {}),
    ).resolves.toEqual({
      sha: fixture.shas.feature,
      resolvedFrom: "branch:feature",
    });
    await expect(resolveInRepo(refs(), npmPackage, {})).resolves.toEqual({
      sha: fixture.shas.four,
      resolvedFrom: "branch:main",
    });
  });
});

describe("readDefaultBranch", () => {
  it("reads HEAD of the bare repository", async () => {
    await expect(readDefaultBranch(fixture.bareDir)).resolves.toBe("main");
  });
});
