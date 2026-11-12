import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("./config", () => ({ dataDir: () => "/unused", gitHostAllowlist: () => [] }));

const { default: prisma } = await import("@cockpit-context/db");
const { fingerprintOf } = await import("./openssh");
const knownHosts = await import("./known-hosts");

const db = prisma as unknown as {
  knownHost: { findMany: MockInstance; upsert: MockInstance; deleteMany: MockInstance };
};

const ED = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const scanned = { keyType: "ssh-ed25519" as const, publicKey: ED, fingerprint: fingerprintOf(ED) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PINNED_HOST_KEYS", () => {
  it("every pinned key's fingerprint matches its blob and type", () => {
    for (const [host, keys] of Object.entries(knownHosts.PINNED_HOST_KEYS)) {
      expect(keys.map((key) => key.keyType).sort(), host).toEqual(
        ["ecdsa-sha2-nistp256", "ssh-ed25519", "ssh-rsa"].sort(),
      );
      for (const key of keys)
        expect(fingerprintOf(key.publicKey), `${host} ${key.keyType}`).toBe(key.fingerprint);
    }
  });

  it("applies to port 22 only", () => {
    expect(knownHosts.pinnedHostKeys("GitHub.com", 22)).toHaveLength(3);
    expect(knownHosts.pinnedHostKeys("github.com", 443)).toEqual([]);
    expect(knownHosts.pinnedHostKeys("git.example.com", 22)).toEqual([]);
  });
});

describe("trustedHostKeys", () => {
  it("merges pinned keys with the owner's confirmed keys for that host and port", async () => {
    db.knownHost.findMany.mockResolvedValue([{ keyType: "ssh-ed25519", publicKey: "AAAA" }]);
    const keys = await knownHosts.trustedHostKeys({
      ownerId: "user-1",
      host: "GitLab.com",
      port: 22,
    });
    expect(keys).toHaveLength(4);
    expect(db.knownHost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: "user-1", host: "gitlab.com", port: 22 },
        take: 20,
      }),
    );
  });
});

describe("scanKnownHost", () => {
  it("returns pinned keys without connecting", async () => {
    const scan = vi.fn();
    const result = await knownHosts.scanKnownHost({ host: "github.com" }, { scan });
    expect(result.pinned).toBe(true);
    expect(scan).not.toHaveBeenCalled();
  });

  it("scans the checked address, not the name", async () => {
    const scan = vi.fn(async () => [scanned]);
    const result = await knownHosts.scanKnownHost(
      { host: "Git.Example.com", port: 2222 },
      { resolver: async () => ["140.82.112.9"], scan },
    );
    expect(scan).toHaveBeenCalledWith("140.82.112.9", 2222);
    expect(result).toEqual({ host: "git.example.com", port: 2222, pinned: false, keys: [scanned] });
  });

  it.each([
    [{ host: "localhost" }, "PRIVATE_ADDRESS"],
    [{ host: "10.0.0.1" }, "PRIVATE_ADDRESS"],
    [{ host: "0:0:0:0:0:0:0:1", port: 6379 }, "PRIVATE_ADDRESS"],
    [{ host: "[0::1]" }, "PRIVATE_ADDRESS"],
    [{ host: "0:0:0:0:0:ffff:a9fe:a9fe" }, "PRIVATE_ADDRESS"],
    [{ host: "-oProxyCommand=x" }, "INVALID_HOST"],
    [{ host: "git.example.com", port: 0 }, "INVALID_HOST"],
  ])("refuses %j", async (input, code) => {
    const scan = vi.fn();
    await expect(
      knownHosts.scanKnownHost(input, { resolver: async () => ["140.82.112.9"], scan }),
    ).rejects.toMatchObject({ code });
    expect(scan).not.toHaveBeenCalled();
  });

  it("canonicalizes an IPv6 literal before scanning it", async () => {
    const scan = vi.fn(async () => [scanned]);
    const result = await knownHosts.scanKnownHost(
      { host: "2606:4700:0:0:0:0:0:0001" },
      { resolver: async () => [], scan },
    );
    expect(result.host).toBe("2606:4700::1");
    expect(scan).toHaveBeenCalledWith("2606:4700::1", 22);
  });

  it("refuses a name that resolves privately", async () => {
    const scan = vi.fn();
    await expect(
      knownHosts.scanKnownHost(
        { host: "internal.example.com" },
        { resolver: async () => ["192.168.1.2"], scan },
      ),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    expect(scan).not.toHaveBeenCalled();
  });

  it("reports a host that offered no keys", async () => {
    await expect(
      knownHosts.scanKnownHost(
        { host: "git.example.com" },
        { resolver: async () => ["140.82.112.9"], scan: async () => [] },
      ),
    ).rejects.toMatchObject({ code: "HOST_SCAN_FAILED" });
  });
});

describe("confirmKnownHost", () => {
  it("validates the key and upserts it with a server-computed fingerprint", async () => {
    db.knownHost.upsert.mockResolvedValue({ id: "h1" });
    await knownHosts.confirmKnownHost({
      ownerId: "user-1",
      host: "Git.Example.com",
      keyType: "ssh-ed25519",
      publicKey: ED,
    });
    expect(db.knownHost.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerId_host_port_fingerprint: {
            ownerId: "user-1",
            host: "git.example.com",
            port: 22,
            fingerprint: scanned.fingerprint,
          },
        },
        select: knownHosts.knownHostSelect,
      }),
    );
  });

  it("refuses a relabeled or garbage key", async () => {
    await expect(
      knownHosts.confirmKnownHost({
        ownerId: "user-1",
        host: "git.example.com",
        keyType: "ssh-rsa",
        publicKey: ED,
      }),
    ).rejects.toMatchObject({ code: "INVALID_HOST" });
    expect(db.knownHost.upsert).not.toHaveBeenCalled();
  });
});

describe("deleteKnownHost", () => {
  it("is owner-scoped and NOT_FOUND on a miss", async () => {
    db.knownHost.deleteMany.mockResolvedValue({ count: 0 });
    await expect(knownHosts.deleteKnownHost({ ownerId: "user-1", id: "h1" })).rejects.toMatchObject(
      {
        code: "KNOWN_HOST_NOT_FOUND",
      },
    );
    expect(db.knownHost.deleteMany).toHaveBeenCalledWith({
      where: { id: "h1", ownerId: "user-1" },
    });
  });
});
