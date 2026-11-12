import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ gitHostAllowlist: () => [] }));

import {
  escapeGoModulePath,
  goModuleRepository,
  lookupRegistry,
  normalizeRepositoryUrl,
  parseCratesCrate,
  parseGoLatest,
  parseNpmManifest,
  parsePypiProject,
  registryRequestUrl,
} from "./registry-lookup";

// Responses recorded from the real registries (2026-10-24), trimmed to the
// fields the parsers read plus a little surrounding shape. No network here.
const FIXTURES = join(import.meta.dirname, "test-support", "registry-fixtures");
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("normalizeRepositoryUrl", () => {
  it.each([
    ["git+https://github.com/TanStack/query.git", "https://github.com/TanStack/query"],
    ["git://github.com/a/b.git", "https://github.com/a/b"],
    ["git+ssh://git@github.com/a/b.git", "https://github.com/a/b"],
    ["git@github.com:a/b.git", "https://github.com/a/b"],
    ["https://github.com/pallets/flask/", "https://github.com/pallets/flask"],
    ["https://github.com/a/b/tree/main/packages/x", "https://github.com/a/b"],
    ["https://gitlab.com/group/sub/proj/-/tree/main", "https://gitlab.com/group/sub/proj"],
    ["http://bitbucket.org/a/b", "https://bitbucket.org/a/b"],
    ["https://codeberg.org/a/b.git", "https://codeberg.org/a/b"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeRepositoryUrl(raw)).toBe(expected);
  });

  it("expands npm shorthands only when allowed", () => {
    expect(normalizeRepositoryUrl("a/b", { allowShorthand: true })).toBe("https://github.com/a/b");
    expect(normalizeRepositoryUrl("gitlab:a/b", { allowShorthand: true })).toBe(
      "https://gitlab.com/a/b",
    );
    expect(normalizeRepositoryUrl("a/b")).toBeNull();
  });

  it.each([
    "https://github.com/onlyowner",
    "file:///etc/passwd",
    "https://127.0.0.1/a/b",
    "ext::sh -c touch% /tmp/pwned",
    "",
  ])("rejects %j", (raw) => {
    expect(normalizeRepositoryUrl(raw)).toBeNull();
  });

  it("drops non-code hosts when wellKnownOnly", () => {
    expect(
      normalizeRepositoryUrl("https://requests.readthedocs.io", { wellKnownOnly: true }),
    ).toBeNull();
  });
});

describe("parseNpmManifest", () => {
  it("reads the repository, its monorepo directory and the latest version", () => {
    expect(
      parseNpmManifest(fixture("npm-tanstack-react-query-latest.json"), "@tanstack/react-query"),
    ).toEqual({
      ecosystem: "npm",
      name: "@tanstack/react-query",
      displayName: "@tanstack/react-query",
      gitUrl: "https://github.com/TanStack/query",
      subdirectory: "packages/react-query",
      latestVersion: "5.104.5",
      homepage: "https://tanstack.com/query",
    });
  });

  it("handles a repository object without a directory", () => {
    const suggestion = parseNpmManifest(fixture("npm-lodash-latest.json"), "lodash");
    expect(suggestion?.gitUrl).toBe("https://github.com/lodash/lodash");
    expect(suggestion?.subdirectory).toBeNull();
  });

  it("accepts the string and shorthand forms and refuses a path-escaping directory", () => {
    expect(parseNpmManifest({ repository: "github:a/b" }, "x")?.gitUrl).toBe(
      "https://github.com/a/b",
    );
    expect(
      parseNpmManifest({ repository: { url: "https://github.com/a/b", directory: "../x" } }, "x")
        ?.subdirectory,
    ).toBeNull();
    expect(parseNpmManifest("not an object", "x")).toBeNull();
  });
});

describe("parsePypiProject", () => {
  it("uses the Source project URL", () => {
    expect(parsePypiProject(fixture("pypi-requests.json"), "requests")).toMatchObject({
      displayName: "requests",
      gitUrl: "https://github.com/psf/requests",
      latestVersion: "2.34.2",
    });
  });

  it("skips docs and chat links and finds the source among them", () => {
    expect(parsePypiProject(fixture("pypi-flask.json"), "flask")?.gitUrl).toBe(
      "https://github.com/pallets/flask",
    );
  });

  it("returns no git URL when only non-code hosts are listed", () => {
    expect(
      parsePypiProject(
        { info: { name: "x", version: "1", project_urls: { Homepage: "https://x.dev" } } },
        "x",
      )?.gitUrl,
    ).toBeNull();
  });
});

describe("parseCratesCrate", () => {
  it("uses the crate's repository and max stable version", () => {
    expect(parseCratesCrate(fixture("crates-serde.json"), "serde")).toMatchObject({
      displayName: "serde",
      gitUrl: "https://github.com/serde-rs/serde",
      latestVersion: "1.0.229",
      homepage: "https://serde.rs",
    });
  });
});

describe("Go modules", () => {
  it("derives the repository and subdirectory from the module path", () => {
    expect(goModuleRepository("github.com/spf13/cobra")).toEqual({
      gitUrl: "https://github.com/spf13/cobra",
      subdirectory: null,
    });
    expect(goModuleRepository("github.com/aws/aws-sdk-go-v2/service/s3/v2")).toEqual({
      gitUrl: "https://github.com/aws/aws-sdk-go-v2",
      subdirectory: "service/s3",
    });
    expect(goModuleRepository("gopkg.in/yaml.v3")).toBeNull();
  });

  it("reads the proxy's @latest answer", () => {
    expect(parseGoLatest(fixture("goproxy-cobra-latest.json"), "github.com/spf13/cobra")).toEqual({
      latestVersion: "v1.10.2",
      gitUrl: "https://github.com/spf13/cobra",
      subdirectory: null,
    });
    expect(
      parseGoLatest(
        { Version: "v3.0.1", Origin: { URL: "https://github.com/go-yaml/yaml" } },
        "gopkg.in/yaml.v3",
      )?.gitUrl,
    ).toBe("https://github.com/go-yaml/yaml");
  });

  it("escapes uppercase letters for the proxy", () => {
    expect(escapeGoModulePath("github.com/BurntSushi/toml")).toBe("github.com/!burnt!sushi/toml");
  });
});

describe("registryRequestUrl", () => {
  it("only ever targets the fixed registry hosts", () => {
    expect(registryRequestUrl("npm", "@tanstack/react-query")).toBe(
      "https://registry.npmjs.org/@tanstack%2freact-query/latest",
    );
    expect(registryRequestUrl("pypi", "requests")).toBe("https://pypi.org/pypi/requests/json");
    expect(registryRequestUrl("cargo", "serde")).toBe("https://crates.io/api/v1/crates/serde");
    expect(registryRequestUrl("go", "github.com/spf13/cobra")).toBe(
      "https://proxy.golang.org/github.com/spf13/cobra/@latest",
    );
  });
});

describe("lookupRegistry", () => {
  it("fetches with a timeout, no redirects and a user agent", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fixture("crates-serde.json")));
    const result = await lookupRegistry(
      { ecosystem: "cargo", name: "serde" },
      { fetch: fetchMock },
    );
    expect(result).toMatchObject({ status: "found", suggestion: { latestVersion: "1.0.229" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://crates.io/api/v1/crates/serde",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ "user-agent": expect.any(String) }),
      }),
    );
  });

  it("normalizes the name before building the URL and never calls out for an invalid one", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fixture("pypi-requests.json")));
    await lookupRegistry({ ecosystem: "pypi", name: "Requests" }, { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pypi.org/pypi/requests/json",
      expect.anything(),
    );
    const never = vi.fn();
    await expect(
      lookupRegistry({ ecosystem: "npm", name: "../../admin" }, { fetch: never }),
    ).resolves.toEqual({ status: "not_found" });
    expect(never).not.toHaveBeenCalled();
  });

  it("maps 404 to not_found and failures to unavailable", async () => {
    await expect(
      lookupRegistry(
        { ecosystem: "npm", name: "nope" },
        { fetch: async () => jsonResponse({ error: "Not found" }, { status: 404 }) },
      ),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      lookupRegistry(
        { ecosystem: "npm", name: "x" },
        {
          fetch: async () => {
            throw new Error("ETIMEDOUT");
          },
        },
      ),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      lookupRegistry(
        { ecosystem: "npm", name: "x" },
        { fetch: async () => new Response("<html>", { status: 200 }) },
      ),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      lookupRegistry(
        { ecosystem: "npm", name: "x" },
        { fetch: async () => jsonResponse({}, { status: 503 }) },
      ),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("still suggests a Go repository from the path when the proxy does not know the module", async () => {
    await expect(
      lookupRegistry(
        { ecosystem: "go", name: "github.com/a/b" },
        { fetch: async () => new Response("not found", { status: 404 }) },
      ),
    ).resolves.toEqual({
      status: "found",
      suggestion: {
        ecosystem: "go",
        name: "github.com/a/b",
        displayName: "github.com/a/b",
        gitUrl: "https://github.com/a/b",
        subdirectory: null,
        latestVersion: null,
        homepage: null,
      },
    });
    await expect(
      lookupRegistry(
        { ecosystem: "go", name: "example.com/mod" },
        { fetch: async () => new Response("gone", { status: 410 }) },
      ),
    ).resolves.toEqual({ status: "not_found" });
  });
});

it.each([
  ["v2", true],
  ["v9", true],
  ["v10", true],
  ["v19", true],
  ["v20", true],
  ["v99", true],
  ["v100", true],
  ["v1", false],
  ["v01", false],
])("handles Go major suffix %s at the root and in nested modules", (suffix, major) => {
  expect(goModuleRepository(`github.com/a/b/${suffix}`)?.subdirectory).toBe(major ? null : suffix);
  expect(goModuleRepository(`github.com/a/b/tools/${suffix}`)?.subdirectory).toBe(
    major ? "tools" : `tools/${suffix}`,
  );
});
