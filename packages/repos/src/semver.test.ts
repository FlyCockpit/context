import { describe, expect, it } from "vitest";

import { compareSemver, parseSemver } from "./semver";

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right) throw new Error("unparsable");
    return compareSemver(left, right);
  });
}

describe("parseSemver", () => {
  it("parses partial and prefixed versions", () => {
    expect(parseSemver("v5.2")).toEqual({ major: 5, minor: 2, patch: 0, prerelease: [] });
    expect(parseSemver("1.0.0-rc.1+build.5")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ["rc", 1],
    });
    expect(parseSemver("nightly")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders by semver precedence", () => {
    expect(
      sorted([
        "1.0.0",
        "1.0.0-rc.1",
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "0.9.10",
        "0.9.9",
        "10.0.0",
        "2.0.0",
      ]),
    ).toEqual([
      "0.9.9",
      "0.9.10",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-rc.1",
      "1.0.0",
      "2.0.0",
      "10.0.0",
    ]);
  });
});
