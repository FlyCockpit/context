import * as crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const {
  isBootstrapTokenActive,
  issueBootstrapToken,
  issueBootstrapTokenIfNeeded,
  revokeBootstrapToken,
  verifyBootstrapToken,
} = await import("./bootstrap-token");

afterEach(() => {
  revokeBootstrapToken();
  vi.mocked(crypto.timingSafeEqual).mockClear();
});

describe("verifyBootstrapToken", () => {
  it("accepts only the active token", () => {
    const token = issueBootstrapToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyBootstrapToken(token)).toBe(true);
    expect(verifyBootstrapToken(`${token}x`)).toBe(false);
    expect(verifyBootstrapToken(token.slice(1))).toBe(false);
    expect(verifyBootstrapToken("")).toBe(false);
    expect(verifyBootstrapToken(undefined)).toBe(false);
    expect(verifyBootstrapToken(42)).toBe(false);
    expect(verifyBootstrapToken("x".repeat(10_000))).toBe(false);
  });

  it("compares fixed-length digests in constant time for every input, matching or not", () => {
    const token = issueBootstrapToken();
    for (const candidate of [token, "short", "x".repeat(300), undefined]) {
      verifyBootstrapToken(candidate);
    }
    const calls = vi.mocked(crypto.timingSafeEqual).mock.calls;
    expect(calls).toHaveLength(4);
    for (const [a, b] of calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });

  it("still runs the comparison, and refuses, when no token is active", () => {
    expect(isBootstrapTokenActive()).toBe(false);
    expect(verifyBootstrapToken("anything")).toBe(false);
    expect(crypto.timingSafeEqual).toHaveBeenCalledOnce();
  });

  it("is spent by revocation (the first account closes the bootstrap)", () => {
    const token = issueBootstrapToken();
    revokeBootstrapToken();
    expect(verifyBootstrapToken(token)).toBe(false);
  });
});

describe("issueBootstrapTokenIfNeeded (server start)", () => {
  it("issues and logs a token once, under the [bootstrap] prefix, when no account exists", async () => {
    const log = vi.fn();
    const issued = await issueBootstrapTokenIfNeeded({
      adminEmailCount: 1,
      countUsers: async () => 0,
      log,
    });
    expect(issued).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    const message = String(log.mock.calls[0]?.[0]);
    const token = /\[bootstrap\] {3}(\S+)/.exec(message)?.[1];
    expect(token).toBeDefined();
    expect(verifyBootstrapToken(token)).toBe(true);
    for (const line of message.split("\n")) expect(line.startsWith("[bootstrap]")).toBe(true);
  });

  it("a restart issues a new token and the previous one stops working", async () => {
    const tokens: string[] = [];
    for (let boot = 0; boot < 2; boot++) {
      await issueBootstrapTokenIfNeeded({
        adminEmailCount: 1,
        countUsers: async () => 0,
        log: (m) => tokens.push(/\[bootstrap\] {3}(\S+)/.exec(m)?.[1] ?? ""),
      });
    }
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(verifyBootstrapToken(tokens[0])).toBe(false);
    expect(verifyBootstrapToken(tokens[1])).toBe(true);
  });

  it("issues and logs nothing once an account exists (a restart after the bootstrap)", async () => {
    issueBootstrapToken();
    const log = vi.fn();
    await expect(
      issueBootstrapTokenIfNeeded({ adminEmailCount: 1, countUsers: async () => 1, log }),
    ).resolves.toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(isBootstrapTokenActive()).toBe(false);
  });

  it("issues nothing without ADMIN_EMAILS (and skips the database read)", async () => {
    const countUsers = vi.fn(async () => 0);
    const log = vi.fn();
    await expect(
      issueBootstrapTokenIfNeeded({ adminEmailCount: 0, countUsers, log }),
    ).resolves.toBe(false);
    expect(countUsers).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
