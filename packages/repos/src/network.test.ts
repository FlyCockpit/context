import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dataDir: "", allowlist: [] as string[] }));
vi.mock("./config", () => ({
  dataDir: () => state.dataDir,
  gitHostAllowlist: () => state.allowlist,
}));
const trustedHostKeys = vi.hoisted(() => vi.fn());
vi.mock("./known-hosts", () => ({ trustedHostKeys }));
const loadSshPrivateKey = vi.hoisted(() => vi.fn());
vi.mock("./ssh-keys", () => ({ loadSshPrivateKey }));

const { hostKeyAlias, sshCommand, withGitNetwork } = await import("./network");
const { withLock } = await import("./locks");
const { parseRemoteUrl } = await import("./remote-url");

const publicResolver = async () => ["140.82.112.3"];

beforeAll(async () => {
  state.dataDir = await mkdtemp(path.join(tmpdir(), "cockpit-context-network-"));
});
afterAll(async () => {
  await rm(state.dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
});

describe("withGitNetwork (https)", () => {
  it("pins the checked address with curloptResolve", async () => {
    const network = await withGitNetwork(
      { remote: parseRemoteUrl("https://github.com/a/b"), ownerId: null, sshKeyId: null },
      async (n) => n,
      { resolver: publicResolver },
    );
    expect(network).toEqual({
      config: ["http.curloptResolve=github.com:443:140.82.112.3"],
      env: {},
    });
  });

  it("brackets IPv6 addresses", async () => {
    const network = await withGitNetwork(
      { remote: parseRemoteUrl("https://git.example.com:8443/a/b"), ownerId: null, sshKeyId: null },
      async (n) => n,
      { resolver: async () => ["2606:4700::1"] },
    );
    expect(network.config).toEqual(["http.curloptResolve=git.example.com:8443:[2606:4700::1]"]);
  });

  it("re-checks DNS at connect time and refuses a private answer", async () => {
    const fn = vi.fn();
    await expect(
      withGitNetwork(
        { remote: parseRemoteUrl("https://rebind.example.com/a/b"), ownerId: null, sshKeyId: null },
        fn,
        { resolver: async () => ["127.0.0.1"] },
      ),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("withGitNetwork (ssh)", () => {
  const remote = parseRemoteUrl("ssh://git@git.example.com:2222/team/repo.git");

  it("requires a key", async () => {
    await expect(
      withGitNetwork({ remote, ownerId: "user-1", sshKeyId: null }, vi.fn(), {
        resolver: publicResolver,
      }),
    ).rejects.toMatchObject({ code: "SSH_KEY_REQUIRED" });
  });

  it("refuses an unconfirmed host before decrypting anything", async () => {
    trustedHostKeys.mockResolvedValue([]);
    await expect(
      withGitNetwork({ remote, ownerId: "user-1", sshKeyId: "k1" }, vi.fn(), {
        resolver: publicResolver,
      }),
    ).rejects.toMatchObject({
      code: "HOST_KEY_UNCONFIRMED",
      details: { host: "git.example.com", port: 2222 },
    });
    expect(loadSshPrivateKey).not.toHaveBeenCalled();
  });

  it("writes 0600 key and known_hosts files for the call and removes them after", async () => {
    trustedHostKeys.mockResolvedValue([{ keyType: "ssh-ed25519", publicKey: "AAAAC3Nz" }]);
    loadSshPrivateKey.mockResolvedValue("PRIVATE KEY");
    let seen: { command: string; keyFile: string; knownHosts: string } | null = null;
    await withGitNetwork(
      { remote, ownerId: "user-1", sshKeyId: "k1" },
      async (network) => {
        const command = network.env.GIT_SSH_COMMAND ?? "";
        const keyFile = /'-i' '([^']+)'/.exec(command)?.[1] ?? "";
        const knownHostsFile = /'UserKnownHostsFile=([^']+)'/.exec(command)?.[1] ?? "";
        expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
        expect(await readFile(keyFile, "utf8")).toBe("PRIVATE KEY\n");
        seen = { command, keyFile, knownHosts: await readFile(knownHostsFile, "utf8") };
        expect(network.env.GIT_SSH_VARIANT).toBe("ssh");
      },
      { resolver: publicResolver },
    );
    expect(loadSshPrivateKey).toHaveBeenCalledWith({ ownerId: "user-1", keyId: "k1" });
    const result = seen as unknown as { command: string; keyFile: string; knownHosts: string };
    expect(result.knownHosts).toBe("[git.example.com]:2222 ssh-ed25519 AAAAC3Nz\n");
    expect(result.command).toContain("'HostName=140.82.112.3'");
    expect(result.command).toContain("'HostKeyAlias=[git.example.com]:2222'");
    expect(result.command).toContain("'StrictHostKeyChecking=yes'");
    await expect(stat(result.keyFile)).rejects.toThrow();
  });

  it("removes the key file even when git fails", async () => {
    trustedHostKeys.mockResolvedValue([{ keyType: "ssh-ed25519", publicKey: "AAAAC3Nz" }]);
    loadSshPrivateKey.mockResolvedValue("PRIVATE KEY");
    let keyFile = "";
    await expect(
      withGitNetwork(
        { remote, ownerId: "user-1", sshKeyId: "k1" },
        async (network) => {
          keyFile = /'-i' '([^']+)'/.exec(network.env.GIT_SSH_COMMAND ?? "")?.[1] ?? "";
          throw new Error("git failed");
        },
        { resolver: publicResolver },
      ),
    ).rejects.toThrow("git failed");
    await expect(stat(keyFile)).rejects.toThrow();
  });
});

describe("withGitNetwork with an allowlisted internal host", () => {
  beforeEach(() => {
    state.allowlist = ["gitlab.corp.example"];
  });
  afterAll(() => {
    state.allowlist = [];
  });

  it("pins the internal address for HTTPS", async () => {
    const network = await withGitNetwork(
      { remote: parseRemoteUrl("https://gitlab.corp.example/a/b"), ownerId: null, sshKeyId: null },
      async (n) => n,
      { resolver: async () => ["10.0.0.5"] },
    );
    expect(network.config).toEqual(["http.curloptResolve=gitlab.corp.example:443:10.0.0.5"]);
  });

  it("pins the internal address for SSH and keeps host-key checks on the name", async () => {
    trustedHostKeys.mockResolvedValue([{ keyType: "ssh-ed25519", publicKey: "AAAAC3Nz" }]);
    loadSshPrivateKey.mockResolvedValue("PRIVATE KEY");
    const command = await withGitNetwork(
      {
        remote: parseRemoteUrl("git@gitlab.corp.example:team/repo.git"),
        ownerId: "user-1",
        sshKeyId: "k1",
      },
      async (n) => n.env.GIT_SSH_COMMAND ?? "",
      { resolver: async () => ["fd12:3456::7"] },
    );
    expect(command).toContain("'HostName=fd12:3456::7'");
    expect(command).toContain("'HostKeyAlias=gitlab.corp.example'");
  });

  it("refuses a non-listed private host", async () => {
    const fn = vi.fn();
    await expect(
      withGitNetwork(
        { remote: parseRemoteUrl("https://gitea.corp.example/a/b"), ownerId: null, sshKeyId: null },
        fn,
        { resolver: async () => ["10.0.0.5"] },
      ),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(["169.254.169.254", "fd00:ec2::254", "127.0.0.1", "::1"])(
    "refuses the allowlisted host resolving to %s",
    async (address) => {
      const fn = vi.fn();
      await expect(
        withGitNetwork(
          {
            remote: parseRemoteUrl("https://gitlab.corp.example/a/b"),
            ownerId: null,
            sshKeyId: null,
          },
          fn,
          { resolver: async () => [address] },
        ),
      ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it("connects only to the address it checked when DNS rebinds", async () => {
    // First lookup (this connect's check) answers the internal address; any
    // later lookup would answer loopback. git gets the pinned first answer
    // and never resolves the name itself, so the second answer is unreachable.
    const answers = [["10.0.0.5"], ["127.0.0.1"]];
    const resolver = vi.fn(async () => answers.shift() ?? ["127.0.0.1"]);
    const remote = parseRemoteUrl("https://gitlab.corp.example/a/b");
    const network = await withGitNetwork(
      { remote, ownerId: null, sshKeyId: null },
      async (n) => n,
      { resolver },
    );
    expect(resolver).toHaveBeenCalledOnce();
    expect(network.config).toEqual(["http.curloptResolve=gitlab.corp.example:443:10.0.0.5"]);
    expect(JSON.stringify(network)).not.toContain("127.0.0.1");
    // The next connect re-resolves, sees loopback and is refused before git runs.
    const fn = vi.fn();
    await expect(
      withGitNetwork({ remote, ownerId: null, sshKeyId: null }, fn, { resolver }),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("sshCommand", () => {
  it("quotes every word for sh -c and ignores ssh config", () => {
    const command = sshCommand({
      keyFile: "/data dir/tmp/inv-1/id",
      knownHostsFile: "/data/tmp/it's/known_hosts",
      hostKeyAlias: hostKeyAlias("github.com", 22),
      address: "140.82.112.3",
    });
    expect(command.startsWith("'ssh' '-F' '/dev/null' '-i' '/data dir/tmp/inv-1/id'")).toBe(true);
    expect(command).toContain(`'UserKnownHostsFile=/data/tmp/it'\\''s/known_hosts'`);
    expect(command).toContain("'HostKeyAlias=github.com'");
    expect(command).toContain("'IdentitiesOnly=yes'");
  });
});

describe("request-local SSH key", () => {
  it.each([false, true])(
    "cleans the private 0600 file and 0700 dir on failure=%s",
    async (fail) => {
      trustedHostKeys.mockResolvedValue([{ keyType: "ssh-ed25519", publicKey: "AAAAC3Nz" }]);
      let keyFile = "";
      const call = withGitNetwork(
        {
          remote: parseRemoteUrl("git@example.com:o/r"),
          ownerId: "user-1",
          sshKeyId: null,
          privateKey: "ONE_TIME_SENTINEL",
        },
        async (network) => {
          keyFile = /'-i' '([^']+)'/.exec(network.env.GIT_SSH_COMMAND ?? "")?.[1] ?? "";
          expect((await stat(path.dirname(keyFile))).mode & 0o777).toBe(0o700);
          expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
          expect(await readFile(keyFile, "utf8")).toBe("ONE_TIME_SENTINEL\n");
          expect(JSON.stringify(network)).not.toContain("ONE_TIME_SENTINEL");
          if (fail) throw new Error("failed");
        },
        { resolver: publicResolver },
      );
      if (fail) await expect(call).rejects.toThrow("failed");
      else await call;
      expect(loadSshPrivateKey).not.toHaveBeenCalled();
      await expect(stat(path.dirname(keyFile))).rejects.toThrow();
    },
  );

  it("keeps known-host trust and connect-time private-address refusal unchanged", async () => {
    const fn = vi.fn();
    const spec = {
      remote: parseRemoteUrl("git@example.com:o/r"),
      ownerId: "user-1",
      sshKeyId: null,
      privateKey: "ONE_TIME_SENTINEL",
    };
    trustedHostKeys.mockResolvedValue([]);
    await expect(withGitNetwork(spec, fn, { resolver: publicResolver })).rejects.toMatchObject({
      code: "HOST_KEY_UNCONFIRMED",
    });
    trustedHostKeys.mockResolvedValue([{ keyType: "ssh-ed25519", publicKey: "AAAAC3Nz" }]);
    await expect(
      withGitNetwork(spec, fn, { resolver: async () => ["127.0.0.1"] }),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    expect(fn).not.toHaveBeenCalled();
  });
});

it("releases the repository gate when DNS preparation is aborted, without invoking git", async () => {
  const controller = new AbortController();
  const git = vi.fn();
  let started!: () => void;
  const dnsStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const operation = withLock(
    "dns-abort-repository",
    () =>
      withGitNetwork(
        {
          remote: parseRemoteUrl("https://example.com/o/r"),
          ownerId: null,
          sshKeyId: null,
          signal: controller.signal,
        },
        git,
        {
          resolver: () => {
            started();
            return new Promise(() => {});
          },
        },
      ),
    controller.signal,
  );
  await dnsStarted;
  controller.abort();
  await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  expect(git).not.toHaveBeenCalled();
  await expect(withLock("dns-abort-repository", async () => "next")).resolves.toBe("next");
});
