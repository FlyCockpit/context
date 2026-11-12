import { describe, expect, it } from "vitest";

import {
  fromStoredEcosystem,
  normalizePackageName,
  packageIdentifier,
  parsePackageIdentifier,
  toStoredEcosystem,
} from "./package-names";

describe("normalizePackageName", () => {
  it.each([
    ["npm", "@TanStack/React-Query", "@tanstack/react-query"],
    ["npm", "lodash", "lodash"],
    ["pypi", "Flask_SQLAlchemy", "flask-sqlalchemy"],
    ["pypi", "zope.interface", "zope-interface"],
    ["cargo", "serde_json", "serde_json"],
    ["go", "github.com/spf13/cobra", "github.com/spf13/cobra"],
    ["go", "github.com/BurntSushi/toml", "github.com/BurntSushi/toml"],
    ["git", "owner/repo", "owner/repo"],
  ] as const)("accepts %s %s", (ecosystem, raw, expected) => {
    expect(normalizePackageName(ecosystem, raw)).toBe(expected);
  });

  it.each([
    ["npm", "../../etc/passwd"],
    ["npm", "a b"],
    ["npm", "@scope/pkg/extra"],
    ["pypi", "-leading"],
    ["pypi", "a/b"],
    ["cargo", "1crate"],
    ["cargo", "a/b"],
    ["go", "nodot/pkg"],
    ["go", "GitHub.com/x/y"],
    ["go", "github.com/../y"],
    ["go", "github.com/x?y"],
    ["git", "repo"],
    ["git", "owner/../repo"],
    ["git", "owner/.hidden"],
    ["npm", ""],
    ["cargo", "x".repeat(65)],
  ] as const)("rejects %s %j", (ecosystem, raw) => {
    expect(normalizePackageName(ecosystem, raw)).toBeNull();
  });
});

describe("parsePackageIdentifier", () => {
  it("normalizes the name and keeps one identifier per package", () => {
    expect(parsePackageIdentifier("pypi:Requests")).toEqual({
      ecosystem: "pypi",
      name: "requests",
      identifier: "pypi:requests",
    });
    expect(parsePackageIdentifier("npm:@tanstack/react-query")?.identifier).toBe(
      "npm:@tanstack/react-query",
    );
  });

  it("rejects unknown ecosystems and malformed names", () => {
    expect(parsePackageIdentifier("maven:junit")).toBeNull();
    expect(parsePackageIdentifier("requests")).toBeNull();
    expect(parsePackageIdentifier("npm:../x")).toBeNull();
  });
});

describe("ecosystem spellings", () => {
  it("maps between the API and stored spellings", () => {
    expect(toStoredEcosystem("cargo")).toBe("CARGO");
    expect(fromStoredEcosystem("PYPI")).toBe("pypi");
    expect(packageIdentifier("go", "github.com/a/b")).toBe("go:github.com/a/b");
  });
});
