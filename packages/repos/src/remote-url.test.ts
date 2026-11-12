import { describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ gitHostAllowlist: () => [] }));

import { RepoError } from "./errors";
import { normalizeHost, normalizeRepoPath, parseRemoteUrl, validateRemoteUrl } from "./remote-url";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RepoError) return `${error.code}:${error.details.reason ?? ""}`;
    throw error;
  }
  return "accepted";
}

describe("parseRemoteUrl", () => {
  it.each([
    [
      "https://github.com/TanStack/query.git",
      {
        kind: "https",
        host: "github.com",
        port: 443,
        remoteUrl: "https://github.com/TanStack/query.git",
        remoteKey: "https://github.com/TanStack/query",
      },
    ],
    [
      "https://GitHub.COM/TanStack/query/",
      {
        kind: "https",
        host: "github.com",
        remoteUrl: "https://github.com/TanStack/query/",
        remoteKey: "https://github.com/TanStack/query",
      },
    ],
    [
      "https://git.example.org:8443/group/sub/repo",
      {
        kind: "https",
        port: 8443,
        remoteUrl: "https://git.example.org:8443/group/sub/repo",
        remoteKey: "https://git.example.org:8443/group/sub/repo",
      },
    ],
    ["https://github.com:443/a/b", { remoteUrl: "https://github.com/a/b", port: 443 }],
    [
      "git@github.com:TanStack/query.git",
      {
        kind: "ssh",
        user: "git",
        host: "github.com",
        port: 22,
        remoteUrl: "git@github.com:TanStack/query.git",
        remoteKey: "ssh://git@github.com/TanStack/query",
      },
    ],
    [
      "git@git.example.org:/srv/git/repo.git",
      { remoteKey: "ssh://git@git.example.org/srv/git/repo" },
    ],
    // Home-relative on an arbitrary server: not the same repo as ssh://host/repo.
    ["git@git.example.org:team/repo.git", { remoteKey: "git@git.example.org:team/repo" }],
    [
      "ssh://git@GitLab.com:2222/group/repo.git/",
      {
        kind: "ssh",
        host: "gitlab.com",
        port: 2222,
        remoteUrl: "ssh://git@gitlab.com:2222/group/repo.git/",
        remoteKey: "ssh://git@gitlab.com:2222/group/repo",
      },
    ],
    [
      "ssh://git@bitbucket.org/team/repo",
      { port: 22, remoteKey: "ssh://git@bitbucket.org/team/repo" },
    ],
    ["  https://github.com/a/b  ", { remoteUrl: "https://github.com/a/b" }],
    [
      "https://[2606:4700::1]/a/b",
      { host: "2606:4700::1", remoteKey: "https://[2606:4700::1]/a/b" },
    ],
    ["https://140.82.112.3/a/b", { host: "140.82.112.3" }],
    [
      "ssh://git@[2606:4700:0:0:0:0:0:0001]/a/b",
      { host: "2606:4700::1", remoteKey: "ssh://git@[2606:4700::1]/a/b" },
    ],
  ])("accepts %s", (input, expected) => {
    expect(parseRemoteUrl(input)).toMatchObject(expected);
  });

  it.each([
    ["http://github.com/a/b", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["file:///etc/passwd", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["git://github.com/a/b", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["ext::sh -c touch% /tmp/pwned", "INVALID_REMOTE_URL:characters"],
    ["ext::sh", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["fd::17", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["/srv/git/repo.git", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["../repo", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["github.com:a/b", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["https://user:pass@github.com/a/b", "INVALID_REMOTE_URL:userinfo"],
    ["https://token@github.com/a/b", "INVALID_REMOTE_URL:userinfo"],
    ["https://github.com@evil.example/a/b", "INVALID_REMOTE_URL:userinfo"],
    ["https://github.com/a/b?x=1", "INVALID_REMOTE_URL:query"],
    ["https://github.com/a/b#frag", "INVALID_REMOTE_URL:query"],
    ["https://github.com/", "INVALID_REMOTE_URL:path"],
    ["https://github.com", "INVALID_REMOTE_URL:path"],
    ["https://github.com/a b", "INVALID_REMOTE_URL:characters"],
    ["https://github.com/a\\b", "INVALID_REMOTE_URL:characters"],
    ["https://github.com/a/b\n", "accepted"],
    ["https://github.com/a/\nb", "INVALID_REMOTE_URL:characters"],
    ["https://intranet/a/b", "INVALID_REMOTE_URL:host"],
    ["https://-evil.example/a/b", "INVALID_REMOTE_URL:host"],
    ["https://github.com:99999/a/b", "INVALID_REMOTE_URL:malformed"],
    ["git@-oProxyCommand=touch:x", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["git@-evil.example:a/b", "INVALID_REMOTE_URL:host"],
    ["-oProxyCommand=x@github.com:a/b", "INVALID_REMOTE_URL:unsupported_scheme"],
    ["-git@github.com:a/b", "INVALID_REMOTE_URL:user"],
    ["git@github.com:-oProxyCommand=x", "INVALID_REMOTE_URL:path"],
    ["ssh://-oProxyCommand=x@github.com/a", "INVALID_REMOTE_URL:user"],
    ["ssh://github.com/a/b", "INVALID_REMOTE_URL:user"],
    ["ssh://git:secret@github.com/a/b", "INVALID_REMOTE_URL:userinfo"],
    ["git@github.com:a/../../etc", "INVALID_REMOTE_URL:path"],
    ["", "INVALID_REMOTE_URL:length"],
    [`https://github.com/${"a".repeat(2100)}`, "INVALID_REMOTE_URL:length"],
  ])("rejects %s", (input, expected) => {
    expect(codeOf(() => parseRemoteUrl(input))).toBe(expected);
  });

  it.each([
    "https://127.0.0.1/a/b",
    "https://10.1.2.3/a/b",
    "https://172.16.0.1/a/b",
    "https://192.168.1.10/a/b",
    "https://169.254.169.254/latest/meta-data",
    "https://100.100.100.200/a/b",
    "https://0.0.0.0/a/b",
    "https://[::1]/a/b",
    "https://[fd00::1]/a/b",
    "https://[fe80::1]/a/b",
    "https://[::ffff:127.0.0.1]/a/b",
    "https://[64:ff9b::a9fe:a9fe]/a/b",
    "https://localhost/a/b",
    "https://foo.localhost/a/b",
    "git@127.0.0.1:a/b",
    "ssh://git@[::1]:22/a/b",
    "https://[0:0:0:0:0:0:0:1]/a/b",
    "ssh://git@[0:0:0:0:0:ffff:a9fe:a9fe]/a/b",
  ])("refuses the literal private address in %s", (input) => {
    expect(codeOf(() => parseRemoteUrl(input))).toBe("PRIVATE_ADDRESS:private_address");
  });
});

describe("normalizeRepoPath", () => {
  it.each([
    ["/a/b.git", "/a/b"],
    ["/a/b.GIT/", "/a/b"],
    ["/a/b///", "/a/b"],
    ["a/b", "a/b"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeRepoPath(input)).toBe(expected);
  });
});

describe("normalizeHost", () => {
  it("lowercases and unbrackets", () => {
    expect(normalizeHost("Git.Example.COM")).toBe("git.example.com");
    expect(normalizeHost("[2606:4700::1]")).toBe("2606:4700::1");
  });

  it("canonicalizes IPv6 literals", () => {
    expect(normalizeHost("2606:4700:0000:0000:0000:0000:0000:0001")).toBe("2606:4700::1");
    expect(normalizeHost("[2001:DB9:0:1:0:0:0:1]")).toBe("2001:db9:0:1::1");
  });

  it.each([
    "0:0:0:0:0:0:0:1",
    "0::1",
    "::0:1",
    "0:0::1",
    "0:0:0:0:0:0:0:0",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "::7f00:1",
    "::ffff:0:7f00:1",
    "64:ff9b:1::a9fe:a9fe",
    "fe80::1%eth0",
  ])("refuses the non-canonical private spelling %s", (host) => {
    expect(codeOf(() => normalizeHost(host))).toBe("PRIVATE_ADDRESS:private_address");
  });

  it("refuses a zone id on a public address", () => {
    expect(codeOf(() => normalizeHost("2606:4700::1%eth0"))).toBe("INVALID_REMOTE_URL:host");
  });
});

describe("validateRemoteUrl", () => {
  it("accepts a host whose every address is public", async () => {
    const resolver = async () => ["140.82.112.3", "2606:50c0:8000::153"];
    await expect(validateRemoteUrl("https://github.com/a/b", resolver)).resolves.toMatchObject({
      host: "github.com",
    });
  });

  it.each([
    [["10.0.0.5"]],
    [["140.82.112.3", "127.0.0.1"]],
    [["169.254.169.254"]],
    [["::1"]],
    [["fd12:3456::1"]],
  ])("refuses a name resolving to %j", async (addresses) => {
    await expect(
      validateRemoteUrl("https://rebind.example.com/a/b", async () => addresses),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("reports an unresolvable host", async () => {
    await expect(
      validateRemoteUrl("https://nope.example.com/a/b", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toMatchObject({ code: "HOST_UNRESOLVABLE" });
  });
});

it("forwards source validation cancellation to DNS resolution", async () => {
  let started!: () => void;
  const dnsStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const controller = new AbortController();
  const result = validateRemoteUrl(
    "https://example.com/a/b",
    () => {
      started();
      return new Promise(() => {});
    },
    { signal: controller.signal },
  );
  await dnsStarted;
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});
