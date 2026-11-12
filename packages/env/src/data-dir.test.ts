import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveCockpitContextDataDir } from "./data-dir.js";

// A throwaway "workspace": root marker plus a nested package directory, so the
// walk-up is exercised without depending on where the test runs.
const root = mkdtempSync(path.join(tmpdir(), "cockpit-context-data-dir-"));
writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
const nested = path.join(root, "apps", "server");
mkdirSync(nested, { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveCockpitContextDataDir", () => {
  it("keeps an absolute value", () => {
    expect(resolveCockpitContextDataDir("/srv/cockpit-context/", "development", nested)).toBe(
      "/srv/cockpit-context/",
    );
    expect(resolveCockpitContextDataDir("/data", "production", nested)).toBe("/data");
  });

  it("defaults to /data in production", () => {
    expect(resolveCockpitContextDataDir(undefined, "production", nested)).toBe("/data");
  });

  it("defaults to <workspace root>/.data outside production, whatever the cwd", () => {
    expect(resolveCockpitContextDataDir(undefined, "development", nested)).toBe(
      path.join(root, ".data"),
    );
    expect(resolveCockpitContextDataDir(undefined, "test", root)).toBe(path.join(root, ".data"));
  });

  it("resolves a relative value against the workspace root", () => {
    expect(resolveCockpitContextDataDir("./var/cockpit-context", "development", nested)).toBe(
      path.join(root, "var", "cockpit-context"),
    );
  });
});
