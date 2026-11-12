import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { McpIdentity } from "./credentials";
import type { McpToolDispatch } from "./tool-dispatch";

const mockEnv = vi.hoisted(() => ({
  COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE: 3,
  COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR: 1,
  COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR: undefined as number | undefined,
  COCKPIT_CONTEXT_MCP_WAIT_SECONDS: 5,
}));
vi.mock("@cockpit-context/env/server", () => ({ env: mockEnv }));
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/runs", () => ({ getRunEngine: vi.fn() }));
vi.mock("@cockpit-context/api/lib/packages", () => ({
  consumePackageWriteBudget: vi.fn(),
  ecosystemSchema: z.enum(["npm", "pypi", "cargo", "go", "git"]),
  insertPackage: vi.fn(),
  lower: (value: string) => value.toLowerCase(),
  normalizeNameOrThrow: vi.fn(),
  validatePackageSource: vi.fn(),
}));

const { MCP_TOOLS, registerMcpTools, resetMcpToolRateLimitsForTests, runMcpTool, serializeResult } =
  await import("./tools");
const { bindMcpToolDispatch } = await import("./tool-dispatch");
const { defineTool, McpToolError } = await import("./tools/types");

function identity(overrides: Partial<McpIdentity> = {}): McpIdentity {
  return {
    userId: "user-a",
    credential: { kind: "agent_token", tokenId: "tok-1" },
    label: "Claude Code",
    allowPropose: true,
    autoApprove: false,
    ...overrides,
  };
}

function dispatch(overrides: Partial<McpIdentity> = {}): McpToolDispatch {
  return {
    identity: identity(overrides),
    requestId: "req-1",
    signal: new AbortController().signal,
  };
}

const echoTool = defineTool({
  name: "echo",
  description: "test",
  input: z.object({ text: z.string().max(5) }),
  run: async (input, ctx) => ({ text: input.text, user: ctx.identity.userId }),
});

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0]?.text ?? "";
}

describe("registerMcpTools", () => {
  function registered(dispatchValue: McpToolDispatch | undefined) {
    const names: string[] = [];
    const server = { registerTool: (name: string) => names.push(name) };
    const authInfo = { token: "[verified]", clientId: "c", scopes: ["mcp"] };
    if (dispatchValue) bindMcpToolDispatch(authInfo, dispatchValue);
    registerMcpTools(server as never, { era: "legacy", authInfo } as never);
    return names;
  }

  it("lists every tool for a connection that may propose", () => {
    expect(registered(dispatch())).toEqual([
      "list_dependencies",
      "query_dependency",
      "get_query_result",
      "propose_dependency",
      "get_proposal",
    ]);
  });

  it("hides the propose tools when the propose flag is off", () => {
    expect(registered(dispatch({ allowPropose: false }))).toEqual([
      "list_dependencies",
      "query_dependency",
      "get_query_result",
    ]);
  });

  it("lists no propose tool for an unverified request", () => {
    expect(registered(undefined)).not.toContain("propose_dependency");
  });

  it("advertises descriptions that steer the agent", () => {
    const query = MCP_TOOLS.find((tool) => tool.name === "query_dependency");
    expect(query?.description).toContain("list_dependencies first");
    expect(query?.description).toContain("lockfile");
    // AI disclosure: the "AI and user content" row of docs/product.md.
    expect(query?.description).toMatch(/AI-generated/);
    expect(query?.description).toMatch(/AI model provider/);
    const propose = MCP_TOOLS.find((tool) => tool.name === "propose_dependency");
    expect(propose?.description).toMatch(/human must approve/i);
  });
});

describe("runMcpTool", () => {
  beforeEach(() => {
    mockEnv.COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE = 3;
    mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR = 1;
    mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR = undefined;
    resetMcpToolRateLimitsForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("fails closed without a verified dispatch", async () => {
    const result = await runMcpTool(echoTool, { dispatch: undefined, args: { text: "hi" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: "INTERNAL_ERROR" } });
  });

  it("answers a propose call on a connection that may not propose like an unknown tool", async () => {
    const propose = MCP_TOOLS.find((tool) => tool.name === "propose_dependency");
    if (!propose) throw new Error("missing tool");
    const run = vi.spyOn(propose, "run");
    const result = await runMcpTool(propose, {
      dispatch: dispatch({ allowPropose: false }),
      args: { ecosystem: "npm", name: "left-pad", reason: "x" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Tool propose_dependency not found");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the body with the credential's identity", async () => {
    const result = await runMcpTool(echoTool, { dispatch: dispatch(), args: { text: "hi" } });
    expect(result.structuredContent).toEqual({ text: "hi", user: "user-a" });
  });

  it("names the invalid field without echoing its value", async () => {
    const result = await runMcpTool(echoTool, {
      dispatch: dispatch(),
      args: { text: "secret-value-too-long" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-value-too-long");
    expect(textOf(result)).toContain("text");
  });

  it("limits tool calls per credential", async () => {
    for (let call = 0; call < 3; call += 1) {
      expect(
        (await runMcpTool(echoTool, { dispatch: dispatch(), args: { text: "a" } })).isError,
      ).toBeUndefined();
    }
    const limited = await runMcpTool(echoTool, { dispatch: dispatch(), args: { text: "a" } });
    expect(limited.structuredContent).toMatchObject({ error: { code: "TOO_MANY_REQUESTS" } });
    // Another credential has its own bucket.
    const other = await runMcpTool(echoTool, {
      dispatch: dispatch({ credential: { kind: "oauth", grantId: "g", clientId: "c" } }),
      args: { text: "a" },
    });
    expect(other.isError).toBeUndefined();
  });

  it("limits model-spending queries per credential per hour", async () => {
    const spend = defineTool({ ...echoTool, name: "spend", spendsQuery: true });
    expect(
      (await runMcpTool(spend, { dispatch: dispatch(), args: { text: "a" } })).isError,
    ).toBeUndefined();
    const limited = await runMcpTool(spend, { dispatch: dispatch(), args: { text: "a" } });
    expect(limited.structuredContent).toMatchObject({ error: { code: "QUERY_LIMIT" } });
  });

  describe("per-user query limit", () => {
    const spend = defineTool({ ...echoTool, name: "spend", spendsQuery: true });
    const tokenCredential = (tokenId: string) => ({ kind: "agent_token" as const, tokenId });
    const grantCredential = (grantId: string) => ({
      kind: "oauth" as const,
      grantId,
      clientId: "c",
    });

    async function query(overrides: Partial<McpIdentity>) {
      return runMcpTool(spend, { dispatch: dispatch(overrides), args: { text: "a" } });
    }

    beforeEach(() => {
      mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR = 2;
      mockEnv.COCKPIT_CONTEXT_MCP_TOOL_CALLS_PER_MINUTE = 10;
    });

    it("is unlimited when unset: each credential keeps its own full budget", async () => {
      for (const credential of [
        tokenCredential("t1"),
        tokenCredential("t2"),
        grantCredential("g1"),
      ]) {
        for (let call = 0; call < 2; call += 1) {
          expect((await query({ credential })).isError).toBeUndefined();
        }
        expect((await query({ credential })).structuredContent).toMatchObject({
          error: { code: "QUERY_LIMIT" },
        });
      }
    });

    it("allows the 120th query of a user at the default cap and refuses the 121st", async () => {
      mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR = 120;
      resetMcpToolRateLimitsForTests();
      // 60 credentials of one user, two queries each (their own budget).
      for (let call = 0; call < 120; call += 1) {
        const result = await query({ credential: tokenCredential(`t${Math.floor(call / 2)}`) });
        expect(result.isError).toBeUndefined();
      }
      const refused = await query({ credential: tokenCredential("t-fresh") });
      expect(refused.structuredContent).toMatchObject({ error: { code: "QUERY_LIMIT" } });
      expect(textOf(refused)).toMatch(/account reached its hourly query limit/);
      // Another user is independent.
      expect(
        (await query({ userId: "user-b", credential: tokenCredential("t-b") })).isError,
      ).toBeUndefined();
    });

    it("is unlimited when 0", async () => {
      mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR = 0;
      resetMcpToolRateLimitsForTests();
      for (const credential of [tokenCredential("t1"), tokenCredential("t2")]) {
        for (let call = 0; call < 2; call += 1) {
          expect((await query({ credential })).isError).toBeUndefined();
        }
      }
    });

    it("rejects the (N+1)th query across one user's credentials", async () => {
      mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR = 3;
      resetMcpToolRateLimitsForTests();
      expect((await query({ credential: tokenCredential("t1") })).isError).toBeUndefined();
      expect((await query({ credential: tokenCredential("t1") })).isError).toBeUndefined();
      expect((await query({ credential: grantCredential("g1") })).isError).toBeUndefined();
      const limited = await query({ credential: grantCredential("g1") });
      expect(limited.isError).toBe(true);
      expect(limited.structuredContent).toMatchObject({
        error: { code: "QUERY_LIMIT", retry_after_seconds: expect.any(Number) },
      });
      expect(textOf(limited)).toMatch(/account reached its hourly query limit/);
      // A fresh credential of the same user is still over the user budget.
      const fresh = await query({ credential: tokenCredential("t3") });
      expect(fresh.structuredContent).toMatchObject({ error: { code: "QUERY_LIMIT" } });
    });

    it("leaves another user's budget untouched", async () => {
      mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR = 1;
      resetMcpToolRateLimitsForTests();
      expect((await query({ credential: tokenCredential("t1") })).isError).toBeUndefined();
      expect((await query({ credential: tokenCredential("t2") })).structuredContent).toMatchObject({
        error: { code: "QUERY_LIMIT" },
      });
      expect(
        (await query({ userId: "user-b", credential: tokenCredential("t9") })).isError,
      ).toBeUndefined();
    });

    it("refunds the credential point when the account cap refuses", async () => {
      mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR = 1;
      resetMcpToolRateLimitsForTests();
      const credential = tokenCredential("t1");
      // user-a spends its one account query on another credential…
      expect((await query({ credential: tokenCredential("t0") })).isError).toBeUndefined();
      // …then hits the account cap from t1, twice (t1's own budget is 2).
      for (let call = 0; call < 2; call += 1) {
        const refused = await query({ credential });
        expect(textOf(refused)).toMatch(/account reached/);
      }
      // t1 still has both points (its bucket is keyed on the token, so other
      // users presenting the same credential id read the same bucket).
      expect((await query({ userId: "user-b", credential })).isError).toBeUndefined();
      expect((await query({ userId: "user-c", credential })).isError).toBeUndefined();
      const exhausted = await query({ userId: "user-d", credential });
      expect(textOf(exhausted)).toMatch(/connection reached/);
    });

    it("keeps the credential point when the limiter cannot refund", async () => {
      mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR = 1;
      resetMcpToolRateLimitsForTests();
      const { RateLimiterMemory } = await import("rate-limiter-flexible");
      const reward = vi
        .spyOn(RateLimiterMemory.prototype, "reward")
        .mockRejectedValue(new Error("boom"));
      try {
        const credential = tokenCredential("t1");
        expect((await query({ credential: tokenCredential("t0") })).isError).toBeUndefined();
        expect(textOf(await query({ credential }))).toMatch(/account reached/);
        expect((await query({ userId: "user-b", credential })).isError).toBeUndefined();
        expect(textOf(await query({ userId: "user-c", credential }))).toMatch(/connection reached/);
      } finally {
        reward.mockRestore();
      }
    });

    it("does not charge non-query tools", async () => {
      mockEnv.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR = 1;
      resetMcpToolRateLimitsForTests();
      expect(
        (await runMcpTool(echoTool, { dispatch: dispatch(), args: { text: "a" } })).isError,
      ).toBeUndefined();
      expect((await query({ credential: tokenCredential("t2") })).isError).toBeUndefined();
    });
  });

  it("returns a tool refusal with its code, message and details", async () => {
    const refusing = defineTool({
      ...echoTool,
      name: "refusing",
      run: async () => {
        throw new McpToolError("PACKAGE_NOT_FOUND", "No such dependency.", {
          close_matches: ["npm:a"],
        });
      },
    });
    const result = await runMcpTool(refusing, { dispatch: dispatch(), args: { text: "a" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("No such dependency.");
    expect(result.structuredContent).toEqual({
      error: {
        code: "PACKAGE_NOT_FOUND",
        message: "No such dependency.",
        close_matches: ["npm:a"],
      },
    });
  });

  it("hides unexpected errors behind a generic message", async () => {
    const failing = defineTool({
      ...echoTool,
      name: "failing",
      run: async () => {
        throw new Error("connect ECONNREFUSED postgres://user:pass@db");
      },
    });
    const result = await runMcpTool(failing, { dispatch: dispatch(), args: { text: "a" } });
    expect(textOf(result)).toBe("Internal error");
    expect(JSON.stringify(result)).not.toContain("postgres");
  });
});

describe("serializeResult", () => {
  it("redacts tokens and JWTs, converts dates, and caps the size", () => {
    const token = `cockpit_context_${"x".repeat(43)}`;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlc2ln";
    const result = serializeResult({
      answer: `use ${token} and Bearer ${jwt}`,
      secretDigest: "abc",
      at: new Date("2026-10-24T00:00:00Z"),
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(token);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain("abc");
    expect(result?.structuredContent).toMatchObject({ at: "2026-10-24T00:00:00.000Z" });
    expect(serializeResult({ answer: "x".repeat(300 * 1024) })).toBeNull();
  });
});
