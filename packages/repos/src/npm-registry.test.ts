import { describe, expect, it, vi } from "vitest";

import { fetchNpmGitHead, npmVersionUrl } from "./npm-registry";

const SHA = "a".repeat(40);

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("npmVersionUrl", () => {
  it("encodes scoped names the way the registry expects", () => {
    expect(npmVersionUrl("@tanstack/react-query", "5.2.0")).toBe(
      "https://registry.npmjs.org/@tanstack%2freact-query/5.2.0",
    );
  });
});

describe("fetchNpmGitHead", () => {
  it("returns the version's gitHead from a mocked registry", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ name: "x", version: "1.0.0", gitHead: SHA }),
    );
    await expect(fetchNpmGitHead("@scope/pkg", "1.0.0", { fetch: fetchMock })).resolves.toBe(SHA);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@scope%2fpkg/1.0.0",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it.each([
    ["a missing gitHead", jsonResponse({ version: "1.0.0" })],
    ["a malformed gitHead", jsonResponse({ gitHead: "HEAD; rm -rf /" })],
    ["a 404", jsonResponse({ error: "not found" }, { status: 404 })],
    ["invalid JSON", new Response("not json", { status: 200 })],
    [
      "an oversized body",
      new Response("x", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } }),
    ],
  ])("returns null for %s", async (_label, response) => {
    await expect(
      fetchNpmGitHead("pkg", "1.0.0", { fetch: async () => response }),
    ).resolves.toBeNull();
  });

  it("returns null on a network error and never calls out for an invalid name", async () => {
    await expect(
      fetchNpmGitHead("pkg", "1.0.0", {
        fetch: async () => {
          throw new Error("ECONNRESET");
        },
      }),
    ).resolves.toBeNull();
    const fetchMock = vi.fn();
    await expect(fetchNpmGitHead("../../etc", "1.0.0", { fetch: fetchMock })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
