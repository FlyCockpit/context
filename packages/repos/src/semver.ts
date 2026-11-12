/**
 * Just enough semver for ordering tag suggestions: `MAJOR[.MINOR[.PATCH]]`
 * with an optional `-prerelease` and ignored `+build`, an optional leading
 * `v`. Missing minor/patch count as 0, so `5.2` sorts with `5.2.0`.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

const SEMVER =
  /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(text: string): SemVer | null {
  const match = SEMVER.exec(text);
  if (!match) return null;
  const [, major = "0", minor = "0", patch = "0", pre] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  };
}

/** Semver precedence: negative when a < b. */
export function compareSemver(a: SemVer, b: SemVer): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    // A release outranks any of its prereleases.
    return b.prerelease.length - a.prerelease.length;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left - right;
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}
