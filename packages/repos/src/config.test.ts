import { beforeEach, describe, expect, it, vi } from "vitest";

const envState = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("@cockpit-context/env/server", () => ({
  get env() {
    return envState.env;
  },
  COCKPIT_CONTEXT_DATA_DIR: "/data",
}));

const config = await import("./config");

beforeEach(() => {
  envState.env = { COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS: 300 };
});

describe("config", () => {
  it("exposes the data dir and fetch interval", () => {
    expect(config.dataDir()).toBe("/data");
    expect(config.fetchIntervalMs()).toBe(300_000);
  });

  it("converts COCKPIT_CONTEXT_MAX_STORAGE_GB to decimal bytes", () => {
    envState.env.COCKPIT_CONTEXT_MAX_STORAGE_GB = 20;
    expect(config.maxStorageBytes()).toBe(20_000_000_000n);
    envState.env.COCKPIT_CONTEXT_MAX_STORAGE_GB = 0.5;
    expect(config.maxStorageBytes()).toBe(500_000_000n);
  });

  it("refuses SSH key work without COCKPIT_CONTEXT_ENCRYPTION_KEYS", () => {
    expect(() => config.encryptionKeyring()).toThrow(
      expect.objectContaining({ code: "ENCRYPTION_UNAVAILABLE" }),
    );
  });

  it("parses (and re-parses on change) the keyring", () => {
    envState.env.COCKPIT_CONTEXT_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 1).toString("base64")}`;
    expect(config.encryptionKeyring().current.version).toBe("v1");
    envState.env.COCKPIT_CONTEXT_ENCRYPTION_KEYS = `v2:${Buffer.alloc(32, 2).toString("base64")}`;
    expect(config.encryptionKeyring().current.version).toBe("v2");
  });
});
