import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/env/server", () => ({ env: {} }));
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@cockpit-context/db");
const { closeMatches, findOwnedPackage, levenshtein, listDependencies } = await import(
  "./dependencies"
);

const db = prisma as unknown as {
  package: { findFirst: MockInstance; findMany: MockInstance };
};

describe("listDependencies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists only the owner's packages, bounded, with recent checked-out versions", async () => {
    db.package.findMany.mockResolvedValue([
      {
        identifier: "npm:react",
        displayName: "React",
        ecosystem: "NPM",
        defaultRef: null,
        Repository: {
          defaultBranch: "main",
          Checkouts: [{ sha: "a".repeat(40), resolvedFrom: "tag:v19.0.0", lastUsedAt: null }],
        },
      },
    ]);
    const result = await listDependencies("user-a");
    const args = db.package.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({ ownerId: "user-a" });
    expect(args.take).toBeGreaterThan(0);
    expect(result.dependencies).toEqual([
      {
        identifier: "npm:react",
        display_name: "React",
        ecosystem: "npm",
        default_ref: "main",
        checked_out_versions: [
          { resolved_from: "tag:v19.0.0", sha: "a".repeat(40), last_used_at: null },
        ],
      },
    ]);
  });
});

describe("findOwnedPackage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds the owner's package by normalized identifier", async () => {
    db.package.findFirst.mockResolvedValue({ id: "pkg-1", identifier: "pypi:requests" });
    await expect(
      findOwnedPackage("user-a", "pypi:Requests", { allowPropose: true }),
    ).resolves.toEqual({
      id: "pkg-1",
      identifier: "pypi:requests",
    });
    expect(db.package.findFirst.mock.calls[0]?.[0].where).toEqual({
      ownerId: "user-a",
      identifier: "pypi:requests",
    });
  });

  it("lists close matches and mentions propose_dependency for an unknown identifier", async () => {
    db.package.findFirst.mockResolvedValue(null);
    db.package.findMany.mockResolvedValue([
      { identifier: "npm:escape-string-regexp" },
      { identifier: "pypi:requests" },
    ]);
    const error = await findOwnedPackage("user-a", "npm:escape-string-regex", {
      allowPropose: true,
    }).catch((thrown) => thrown);
    expect(error.code).toBe("PACKAGE_NOT_FOUND");
    expect(error.details).toEqual({ close_matches: ["npm:escape-string-regexp"] });
    expect(error.message).toContain("propose_dependency");
    expect(db.package.findMany.mock.calls[0]?.[0].where).toEqual({ ownerId: "user-a" });
  });

  it("does not mention propose_dependency to a connection that may not propose", async () => {
    db.package.findFirst.mockResolvedValue(null);
    db.package.findMany.mockResolvedValue([]);
    const error = await findOwnedPackage("user-a", "npm:nope", { allowPropose: false }).catch(
      (thrown) => thrown,
    );
    expect(error.message).not.toContain("propose_dependency");
    expect(error.message).toContain("Ask the user");
  });
});

describe("closeMatches", () => {
  it("prefers names containing the request, then by edit distance", () => {
    const owned = ["npm:react", "npm:react-dom", "npm:preact", "pypi:requests"];
    expect(closeMatches("react", owned)).toEqual(["npm:react", "npm:react-dom", "npm:preact"]);
    expect(closeMatches("npm:reqests", ["pypi:requests", "npm:zod"])).toEqual(["pypi:requests"]);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});
