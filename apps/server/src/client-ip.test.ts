import type { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable env so each test can set TRUST_PROXY_HOPS independently.
const mockEnv: { TRUST_PROXY_HOPS: number | undefined } = { TRUST_PROXY_HOPS: 0 };
vi.mock("@cockpit-context/env/server", () => ({ env: mockEnv }));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "10.0.0.1" } }));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));

const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
afterEach(() => warn.mockClear());

const { resolveClientIp } = await import("./client-ip.js");

function ctx(
  opts: { socket?: string; xff?: string },
  raw = new Request("http://app.test/"),
): Context {
  mockGetConnInfo.mockReturnValue({ remote: { address: opts.socket ?? "" } });
  return {
    req: {
      raw,
      header: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? opts.xff : undefined),
    },
  } as unknown as Context;
}

describe("resolveClientIp (TRUST_PROXY_HOPS = 0, the default)", () => {
  beforeEach(() => {
    mockEnv.TRUST_PROXY_HOPS = 0;
  });

  it("uses the loopback socket peer in local dev (no X-Forwarded-For)", () => {
    expect(resolveClientIp(ctx({ socket: "127.0.0.1" }))).toBe("127.0.0.1");
  });

  it("ignores a spoofed X-Forwarded-For from a LAN client", () => {
    // A private-network caller used to pick its own bucket by sending a
    // public-looking X-Forwarded-For. With no trusted proxy it keys on the socket.
    expect(resolveClientIp(ctx({ socket: "192.168.1.20", xff: "203.0.113.9" }))).toBe(
      "192.168.1.20",
    );
    expect(
      resolveClientIp(ctx({ socket: "192.168.1.20", xff: "8.8.8.8, 10.0.0.9, 198.51.100.7" })),
    ).toBe("192.168.1.20");
    expect(resolveClientIp(ctx({ socket: "fd00::1", xff: "2001:db8::5" }))).toBe("fd00::1");
  });

  it("ignores a forged header from a public peer", () => {
    expect(resolveClientIp(ctx({ socket: "198.51.100.50", xff: "203.0.113.1" }))).toBe(
      "198.51.100.50",
    );
  });

  it("treats an unset value like 0 (no heuristic, no leftmost-entry fallback)", () => {
    mockEnv.TRUST_PROXY_HOPS = undefined;
    expect(resolveClientIp(ctx({ socket: "10.0.0.5", xff: "10.0.0.9" }))).toBe("10.0.0.5");
    expect(resolveClientIp(ctx({ socket: "10.0.0.5", xff: "203.0.113.9" }))).toBe("10.0.0.5");
  });

  it("keys every client on the proxy when a proxy exists but hops is 0 (shared bucket)", () => {
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.7" }))).toBe("10.0.0.2");
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.8" }))).toBe("10.0.0.2");
  });

  it.each([undefined, 0])(
    "warns once without IPs for an uncounted proxy (hops %s)",
    async (hops) => {
      mockEnv.TRUST_PROXY_HOPS = hops;
      // A fresh module: the record is once per process, and earlier tests fired it.
      vi.resetModules();
      const fresh = await import("./client-ip.js");
      warn.mockClear();
      // Public peer with a header, or a private peer without one: no record.
      fresh.resolveClientIp(ctx({ socket: "198.51.100.50", xff: "203.0.113.9" }));
      fresh.resolveClientIp(ctx({ socket: "10.0.0.2" }));
      expect(warn).not.toHaveBeenCalled();
      fresh.resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.7" }));
      fresh.resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.8" }));
      expect(warn).toHaveBeenCalledTimes(1);
      // The record names no client or proxy address.
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).not.toMatch(/10\.0\.0\.2|198\.51\.100/);
      expect(message).toContain("Set TRUST_PROXY_HOPS");
      expect(message).toContain("number of trusted reverse proxies");
    },
  );

  it("returns 'unknown' when there is no socket peer", () => {
    expect(resolveClientIp(ctx({ socket: "", xff: "203.0.113.9" }))).toBe("unknown");
  });
});

describe("resolveClientIp (TRUST_PROXY_HOPS = 1, one reverse proxy)", () => {
  beforeEach(() => {
    mockEnv.TRUST_PROXY_HOPS = 1;
  });

  it("returns the client address appended by the proxy", () => {
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.7" }))).toBe("198.51.100.7");
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "2001:db8::5" }))).toBe("2001:db8::5");
    // A public proxy (e.g. a CDN) as the socket peer works the same way.
    expect(resolveClientIp(ctx({ socket: "104.16.0.1", xff: "198.51.100.7" }))).toBe(
      "198.51.100.7",
    );
  });

  it("is not fooled by entries the client prepended", () => {
    expect(
      resolveClientIp(ctx({ socket: "10.0.0.2", xff: "8.8.8.8, 1.1.1.1 , 198.51.100.7" })),
    ).toBe("198.51.100.7");
  });

  it("keys a LAN client behind the proxy on its own address, not its spoofed header", () => {
    // LAN client 192.168.1.20 sends XFF 203.0.113.9; the proxy appends 192.168.1.20.
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "203.0.113.9, 192.168.1.20" }))).toBe(
      "192.168.1.20",
    );
  });

  it("falls back to the socket peer, never the leftmost entry, when the chain is too short", () => {
    // A direct caller bypassing the proxy sends no header: key on its socket.
    expect(resolveClientIp(ctx({ socket: "192.168.1.20" }))).toBe("192.168.1.20");
    expect(resolveClientIp(ctx({ socket: "192.168.1.20", xff: "" }))).toBe("192.168.1.20");
    mockEnv.TRUST_PROXY_HOPS = 2;
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "203.0.113.9" }))).toBe("10.0.0.2");
    mockEnv.TRUST_PROXY_HOPS = 9;
    expect(resolveClientIp(ctx({ socket: "10.0.0.5", xff: "203.0.113.9" }))).toBe("10.0.0.5");
  });

  it("falls back to the socket peer when the trusted entry is malformed", () => {
    for (const xff of [
      "not-an-ip",
      "8.8.8.8, garbage",
      "garbage:443",
      "[garbage]:443",
      "[203.0.113.9]:443",
      "999.1.1.1:80",
      "203.0.113.9:99999",
      "203.0.113.9:",
      "2001:db8::5]:443",
      "198.51.100.7/32",
      ", ,",
      "1.2.3.4,,",
    ]) {
      const expected = xff === "1.2.3.4,," ? "1.2.3.4" : "10.0.0.2";
      expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff })), xff).toBe(expected);
    }
  });

  it("strips a proxy-appended port from the selected entry before validating it", () => {
    // IPv4 with a port (Azure Application Gateway's default format).
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "203.0.113.9:5678" }))).toBe(
      "203.0.113.9",
    );
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "8.8.8.8:1, 198.51.100.7:443" }))).toBe(
      "198.51.100.7",
    );
    // Bracketed IPv6, with and without a port.
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "[2001:db8::1]:5678" }))).toBe(
      "2001:db8::1",
    );
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "[2001:db8::5]" }))).toBe("2001:db8::5");
  });

  it("leaves a bare IPv6 literal alone, even when its last group looks like a port", () => {
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "2001:db8::1" }))).toBe("2001:db8::1");
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "2001:db8::5678" }))).toBe(
      "2001:db8::5678",
    );
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "::ffff:1.2.3.4" }))).toBe(
      "::ffff:1.2.3.4",
    );
  });

  it("takes exactly N from the right for a longer trusted chain", () => {
    // Cloudflare -> Traefik -> app: CF appends the client, Traefik appends CF.
    mockEnv.TRUST_PROXY_HOPS = 2;
    expect(
      resolveClientIp(ctx({ socket: "10.0.0.2", xff: "8.8.8.8, 198.51.100.7, 104.16.0.1" })),
    ).toBe("198.51.100.7");
  });
});

describe("resolveClientIp memoization", () => {
  beforeEach(() => {
    mockEnv.TRUST_PROXY_HOPS = 1;
    mockGetConnInfo.mockClear();
  });

  it("computes once for every Context sharing a raw Request", () => {
    const raw = new Request("http://app.test/");
    const c = ctx({ socket: "10.0.0.5", xff: "198.51.100.7" }, raw);
    expect(resolveClientIp(c)).toBe("198.51.100.7");
    expect(resolveClientIp(c)).toBe("198.51.100.7");
    expect(resolveClientIp(ctx({ socket: "10.0.0.5", xff: "203.0.113.1" }, raw))).toBe(
      "198.51.100.7",
    );
    expect(mockGetConnInfo).toHaveBeenCalledOnce();
  });

  it("never shares an answer between requests", () => {
    expect(resolveClientIp(ctx({ socket: "10.0.0.5", xff: "198.51.100.7" }))).toBe("198.51.100.7");
    expect(resolveClientIp(ctx({ socket: "10.0.0.5", xff: "203.0.113.1" }))).toBe("203.0.113.1");
  });

  it("uses the unknown shared bucket without a socket even with positive trust", () => {
    expect(resolveClientIp(ctx({ xff: "198.51.100.7" }))).toBe("unknown");
  });
});
