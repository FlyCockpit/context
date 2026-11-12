import { describe, expect, it } from "vitest";

import {
  isLoopbackHost,
  mcpPageHref,
  parseMcpOAuthSearch,
  resolveOauthRedirectUrl,
  signedRedirectHost,
  toMcpPublicClientInfo,
} from "./mcp-oauth-search";

const SIGNED =
  "?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcallback&scope=mcp&ba_param=client_id&ba_param=redirect_uri&ba_param=scope&sig=xyz";

describe("parseMcpOAuthSearch", () => {
  it("needs a client id, a signature and the signed-name list", () => {
    expect(parseMcpOAuthSearch(SIGNED)).toEqual({ clientId: "abc", usable: true });
    expect(parseMcpOAuthSearch("?client_id=abc&sig=xyz").usable).toBe(false);
    expect(parseMcpOAuthSearch("?client_id=abc").usable).toBe(false);
    expect(parseMcpOAuthSearch("").usable).toBe(false);
  });
});

describe("signedRedirectHost", () => {
  it("shows the host of the signed redirect_uri", () => {
    expect(signedRedirectHost(SIGNED)).toBe("localhost:8976");
  });

  it("refuses an unsigned or repeated redirect_uri", () => {
    expect(signedRedirectHost(SIGNED.replace("&ba_param=redirect_uri", ""))).toBeNull();
    expect(signedRedirectHost(`${SIGNED}&redirect_uri=https%3A%2F%2Fevil.example`)).toBeNull();
    expect(signedRedirectHost(SIGNED.replace("&sig=xyz", ""))).toBeNull();
  });

  it("shows a non-web scheme as itself", () => {
    const app = SIGNED.replace(
      "http%3A%2F%2Flocalhost%3A8976%2Fcallback",
      encodeURIComponent("cursor://anysphere.cursor-retrieval/oauth"),
    );
    expect(signedRedirectHost(app)).toBe("cursor://anysphere.cursor-retrieval");
  });
});

describe("response helpers", () => {
  it("navigates only on redirect: true with a url", () => {
    expect(resolveOauthRedirectUrl({ redirect: true, url: "http://x/cb?code=1" })).toBe(
      "http://x/cb?code=1",
    );
    expect(resolveOauthRedirectUrl({ redirect: false, url: "http://x" })).toBeNull();
    expect(resolveOauthRedirectUrl(null)).toBeNull();
  });

  it("keeps only the client id and name", () => {
    expect(
      toMcpPublicClientInfo({ client_id: "abc", client_name: "Claude Code", logo_uri: "http://x" }),
    ).toEqual({ clientId: "abc", name: "Claude Code" });
    expect(toMcpPublicClientInfo({})).toBeNull();
  });

  it("keeps the raw query byte for byte", () => {
    expect(mcpPageHref("en-US", "mcp-consent", SIGNED)).toBe(`/en-US/mcp-consent${SIGNED}`);
  });
});

describe("isLoopbackHost", () => {
  it("recognizes this computer, with or without a port", () => {
    expect(isLoopbackHost("localhost:8976")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:33418")).toBe(true);
    expect(isLoopbackHost("[::1]:5000")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("does not mistake a lookalike or a remote host", () => {
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
    expect(isLoopbackHost("app.example.com")).toBe(false);
    expect(isLoopbackHost("myapp://localhost")).toBe(false);
  });
});
