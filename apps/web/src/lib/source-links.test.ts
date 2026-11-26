import { describe, expect, it } from "vitest";

import { parseFileReference, sourceLinks } from "@/lib/source-links";

const SHA = "0ccd60a".padEnd(40, "1");

describe("sourceLinks", () => {
  it("links GitHub files, line ranges and the commit at the exact commit", () => {
    const links = sourceLinks("https://github.com/TanStack/query.git/", SHA);
    expect(links?.commit).toBe(`https://github.com/TanStack/query/commit/${SHA}`);
    expect(
      links?.file({ path: "packages/react-query/src/queryOptions.ts", start: 44, end: 58 }),
    ).toBe(
      `https://github.com/TanStack/query/blob/${SHA}/packages/react-query/src/queryOptions.ts#L44-L58`,
    );
    expect(links?.file({ path: "src/a.ts", start: 12 })).toBe(
      `https://github.com/TanStack/query/blob/${SHA}/src/a.ts#L12`,
    );
    expect(links?.file({ path: "README.md" })).toBe(
      `https://github.com/TanStack/query/blob/${SHA}/README.md`,
    );
  });

  it("links GitLab projects in nested groups with GitLab's line format", () => {
    const links = sourceLinks("https://gitlab.com/group/sub/project", SHA);
    expect(links?.commit).toBe(`https://gitlab.com/group/sub/project/-/commit/${SHA}`);
    expect(links?.file({ path: "lib/x.rb", start: 44, end: 58 })).toBe(
      `https://gitlab.com/group/sub/project/-/blob/${SHA}/lib/x.rb#L44-58`,
    );
  });

  it("encodes each path segment", () => {
    const links = sourceLinks("https://github.com/o/r", SHA);
    expect(links?.file({ path: "app/[id]/page (1).tsx" })).toBe(
      `https://github.com/o/r/blob/${SHA}/app/%5Bid%5D/page%20(1).tsx`,
    );
    expect(links?.file({ path: "a/#b?.ts" })).toBe(
      `https://github.com/o/r/blob/${SHA}/a/%23b%3F.ts`,
    );
  });

  it("accepts full 40- and 64-hex SHAs only, lowercased", () => {
    expect(sourceLinks("https://github.com/o/r", "A".repeat(40))?.commit).toBe(
      `https://github.com/o/r/commit/${"a".repeat(40)}`,
    );
    expect(sourceLinks("https://github.com/o/r", "b".repeat(64))).not.toBeNull();
    for (const sha of [null, undefined, "", "0ccd60a", "g".repeat(40), "a".repeat(41)]) {
      expect(sourceLinks("https://github.com/o/r", sha)).toBeNull();
    }
  });

  it("refuses anything but a plain public https GitHub/GitLab repository", () => {
    for (const url of [
      null,
      "",
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r.git",
      "http://github.com/o/r",
      "https://user:token@github.com/o/r",
      "https://token@github.com/o/r",
      "https://github.com:8443/o/r",
      "https://www.github.com/o/r",
      "https://github.com.evil.example/o/r",
      "https://evil.example/github.com/o/r",
      "https://bitbucket.org/o/r",
      "https://github.com/o",
      "https://github.com/o/r/tree/main",
      "https://github.com/o/r?tab=readme",
      "https://github.com/o/r#readme",
      "https://github.com/o/../r",
      "https://github.com/o/%2e%2e",
      "https://github.com\\o\\r",
      "https://github.com/o/r x",
      "https://gitlab.com/o",
      "https://gitlab.com/o/r/-/tree/main",
      "javascript:alert(1)",
    ]) {
      expect(sourceLinks(url, SHA), String(url)).toBeNull();
    }
  });
});

describe("parseFileReference", () => {
  it("reads paths with optional line or range", () => {
    expect(parseFileReference("packages/react-query/src/queryOptions.ts:44-58")).toEqual({
      path: "packages/react-query/src/queryOptions.ts",
      start: 44,
      end: 58,
    });
    expect(parseFileReference("src/index.ts:12")).toEqual({ path: "src/index.ts", start: 12 });
    expect(parseFileReference("src/index.ts:7-7")).toEqual({ path: "src/index.ts", start: 7 });
    expect(parseFileReference("lib/router/index.js")).toEqual({ path: "lib/router/index.js" });
    expect(parseFileReference("./src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(parseFileReference("package.json")).toEqual({ path: "package.json" });
    expect(parseFileReference("README.md:3")).toEqual({ path: "README.md", start: 3 });
    expect(parseFileReference("bin/cli:20")).toEqual({ path: "bin/cli", start: 20 });
    expect(parseFileReference(".github/workflows/ci.yml")).toEqual({
      path: ".github/workflows/ci.yml",
    });
    expect(parseFileReference("app/[id]/page.tsx")).toEqual({ path: "app/[id]/page.tsx" });
  });

  it("leaves code that is not a relative file path alone", () => {
    for (const text of [
      "useQuery()",
      "queryClient.invalidateQueries",
      "console.log",
      "z.object",
      "@tanstack/react-query",
      "react-dom/client",
      "src/",
      "/etc/passwd",
      "../secret.ts",
      "src/../../x.ts",
      "src//a.ts",
      "src/./a.ts",
      "https://example.com/a.ts",
      "C:\\x\\a.ts",
      "src/a.ts:0",
      "src/a.ts:9-3",
      "src/a.ts:",
      "src/a b.ts",
      "src/a.ts#L3",
      "npm install x",
      "",
    ]) {
      expect(parseFileReference(text), text).toBeNull();
    }
  });
});
