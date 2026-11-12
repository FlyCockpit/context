import { afterEach, describe, expect, it, vi } from "vitest";

const allowlistState = vi.hoisted(() => ({ hosts: [] as string[] }));
vi.mock("./config", () => ({ gitHostAllowlist: () => allowlistState.hosts }));

import { canonicalAddress, isForbiddenAddress, resolvePublicAddress } from "./address-policy";

describe("isForbiddenAddress", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "febf::1",
    "::ffff:10.0.0.1",
    "ff02::1",
    "2001:db8::1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::10.0.0.1",
    "2002:7f00:0001::1",
    "2002:c058:6301::1",
    "192.88.99.1",
    // Non-canonical spellings of loopback, unspecified and the metadata address.
    "0:0:0:0:0:0:0:1",
    "0::1",
    "::0:1",
    "0:0::1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "0:0:0:0:0:0:0:0",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:169.254.169.254",
    "FE80:0:0:0:0:0:0:1",
    "FD00:0:0:0:0:0:0:1",
    // ::/8: IPv4-compatible, IPv4-translated, even with a public IPv4 inside.
    "::7f00:1",
    "::ffff:0:7f00:1",
    "::8.8.8.8",
    "::ffff:8.8.8.8",
    "100::1",
    "fec0::1",
    "64:ff9b:1::808:808",
    "not-an-ip",
    "1::2::3",
    "12345::1",
  ])("refuses %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    "140.82.112.3",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "64:ff9b::808:808",
    "2002:808:808::1",
    "2606:4700:4700:0:0:0:0:1111",
  ])("allows %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });
});

describe("resolvePublicAddress", () => {
  it("returns a public literal without resolving", async () => {
    const resolver = async () => {
      throw new Error("must not resolve");
    };
    await expect(resolvePublicAddress("1.1.1.1", resolver)).resolves.toBe("1.1.1.1");
    await expect(resolvePublicAddress("[2606:4700::1]", resolver)).resolves.toBe("2606:4700::1");
  });

  it("returns the first resolved address when every answer is public", async () => {
    await expect(
      resolvePublicAddress("github.com", async () => ["140.82.112.3", "140.82.112.4"]),
    ).resolves.toBe("140.82.112.3");
  });

  it("prefers an IPv4 answer over an earlier IPv6 one", async () => {
    await expect(
      resolvePublicAddress("dual.example.com", async () => ["2606:4700::1", "140.82.112.3"]),
    ).resolves.toBe("140.82.112.3");
  });

  it("returns an IPv6-only answer in canonical form", async () => {
    await expect(
      resolvePublicAddress("v6.example.com", async () => ["2606:4700:0:0:0:0:0:0001"]),
    ).resolves.toBe("2606:4700::1");
  });

  it.each(["0:0:0:0:0:0:0:1", "[0:0:0:0:0:0:0:1]", "0:0:0:0:0:ffff:a9fe:a9fe"])(
    "refuses the non-canonical private literal %s without resolving",
    async (host) => {
      const resolver = async () => {
        throw new Error("must not resolve");
      };
      await expect(resolvePublicAddress(host, resolver)).rejects.toMatchObject({
        code: "PRIVATE_ADDRESS",
      });
    },
  );

  it("refuses a name that resolves to a non-canonical loopback spelling", async () => {
    await expect(
      resolvePublicAddress("sneaky.example.com", async () => ["0:0:0:0:0:0:0:1"]),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("refuses when any answer is private", async () => {
    await expect(
      resolvePublicAddress("mixed.example.com", async () => ["140.82.112.3", "192.168.1.1"]),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("refuses an empty answer", async () => {
    await expect(resolvePublicAddress("empty.example.com", async () => [])).rejects.toMatchObject({
      code: "HOST_UNRESOLVABLE",
    });
  });
});

describe("resolvePublicAddress with COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST", () => {
  afterEach(() => {
    allowlistState.hosts = [];
  });
  const resolveTo = (addresses: string[]) => async () => addresses;

  it.each(["10.0.0.5", "172.16.4.2", "192.168.10.20", "100.64.1.1", "fd12:3456::7", "fc00::1"])(
    "lets an allowlisted host resolve to internal %s",
    async (address) => {
      allowlistState.hosts = ["gitlab.corp.example"];
      await expect(resolvePublicAddress("gitlab.corp.example", resolveTo([address]))).resolves.toBe(
        canonicalAddress(address),
      );
    },
  );

  it("refuses a private host that is not on the allowlist", async () => {
    allowlistState.hosts = ["gitlab.corp.example"];
    await expect(
      resolvePublicAddress("gitea.corp.example", resolveTo(["10.0.0.5"])),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    // Exact match only: a subdomain or parent of a listed name is not listed.
    await expect(
      resolvePublicAddress("evil.gitlab.corp.example", resolveTo(["10.0.0.5"])),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(
      resolvePublicAddress("corp.example", resolveTo(["10.0.0.5"])),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it.each([
    "169.254.169.254",
    "169.254.170.2",
    "fd00:ec2::254",
    "fd00:ec2:0:0:0:0:0:254",
    "100.100.100.200",
    "127.0.0.1",
    "127.10.0.1",
    "::1",
    "0.0.0.0",
    "::",
    "fe80::1",
    "224.0.0.1",
    "255.255.255.255",
    "::ffff:10.0.0.5",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::a00:5",
    "2002:a9fe:a9fe::1",
    "198.18.0.1",
  ])("still refuses %s for an allowlisted host", async (address) => {
    allowlistState.hosts = ["gitlab.corp.example"];
    await expect(
      resolvePublicAddress("gitlab.corp.example", resolveTo([address])),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("refuses an allowlisted host when ANY answer is loopback or metadata (rebinding)", async () => {
    allowlistState.hosts = ["gitlab.corp.example"];
    await expect(
      resolvePublicAddress("gitlab.corp.example", resolveTo(["10.0.0.5", "127.0.0.1"])),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(
      resolvePublicAddress("gitlab.corp.example", resolveTo(["140.82.112.3", "169.254.169.254"])),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("never allowlists an IP literal", async () => {
    allowlistState.hosts = ["10.0.0.5"];
    await expect(resolvePublicAddress("10.0.0.5", resolveTo([]))).rejects.toMatchObject({
      code: "PRIVATE_ADDRESS",
    });
  });

  it("matches the host name case-insensitively and honors an explicit override", async () => {
    allowlistState.hosts = ["gitlab.corp.example"];
    await expect(
      resolvePublicAddress("GitLab.Corp.Example", resolveTo(["10.0.0.5"])),
    ).resolves.toBe("10.0.0.5");
    await expect(
      resolvePublicAddress("gitlab.corp.example", resolveTo(["10.0.0.5"]), { allowlist: [] }),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });
});

describe("canonicalAddress", () => {
  it.each([
    ["0:0:0:0:0:0:0:1", "::1"],
    ["0:0:0:0:0:0:0:0", "::"],
    ["2001:0db8:0000:0000:0001:0000:0000:0001", "2001:db8::1:0:0:1"],
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["::ffff:169.254.169.254", "::ffff:a9fe:a9fe"],
    ["FE80::1%eth0", "fe80::1"],
    ["1.2.3.4", "1.2.3.4"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalAddress(input)).toBe(expected);
  });
});

describe("DNS lifetime", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds a resolver that never settles", async () => {
    vi.useFakeTimers();
    const result = resolvePublicAddress("example.com", () => new Promise(() => {}));
    const rejected = expect(result).rejects.toMatchObject({ code: "HOST_UNRESOLVABLE" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes abort and disposes its timer and listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const resolver = vi.fn(() => new Promise<string[]>(() => {}));
    const result = resolvePublicAddress("example.com", resolver, { signal: controller.signal });
    await Promise.resolve();
    expect(resolver).toHaveBeenCalledOnce();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("disposes resources when lookup success is %s", async (success) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = resolvePublicAddress(
      "example.com",
      async () => {
        if (!success) throw new Error("DNS failure");
        return ["8.8.8.8"];
      },
      { signal: controller.signal },
    );
    if (success) await expect(result).resolves.toBe("8.8.8.8");
    else await expect(result).rejects.toMatchObject({ code: "HOST_UNRESOLVABLE" });
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
