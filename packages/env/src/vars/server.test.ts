import { describe, expect, it } from "vitest";
import { MAX_RATE_BUDGET_COUNT } from "../rate-budgets.js";
import { serverVars } from "./server.js";

describe.each([
  ["COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER", 100],
  ["COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER", 10],
  ["COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER", 20],
] as const)("%s", (key, defaultCount) => {
  const schema = serverVars[key];

  it(`defaults to ${defaultCount}`, () => {
    expect(schema.parse(undefined)).toBe(defaultCount);
  });

  it("accepts whole numbers from 1 to the maximum", () => {
    expect(schema.parse("1")).toBe(1);
    expect(schema.parse(" 5000 ")).toBe(5000);
    expect(schema.parse(String(MAX_RATE_BUDGET_COUNT))).toBe(MAX_RATE_BUDGET_COUNT);
  });

  it.each(["0", "-1", "1.5", "1e3", "0x10", "ten", "", String(MAX_RATE_BUDGET_COUNT + 1)])(
    "rejects %j (a cap cannot be turned off)",
    (value) => {
      const result = schema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain(key);
    },
  );
});

describe("COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR", () => {
  const schema = serverVars.COCKPIT_CONTEXT_MCP_QUERIES_PER_USER_PER_HOUR;

  it("defaults to 120 queries per user per hour", () => {
    expect(schema.parse(undefined)).toBe(120);
  });

  it("accepts 0 (unlimited) and positive whole numbers", () => {
    expect(schema.parse("0")).toBe(0);
    expect(schema.parse(" 25 ")).toBe(25);
    expect(schema.parse(String(MAX_RATE_BUDGET_COUNT))).toBe(MAX_RATE_BUDGET_COUNT);
  });

  it.each(["-1", "1.5", "1e3", "0x10", "ten", String(MAX_RATE_BUDGET_COUNT + 1)])(
    "rejects %s",
    (value) => {
      expect(schema.safeParse(value).success).toBe(false);
    },
  );
});

describe("COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER", () => {
  const schema = serverVars.COCKPIT_CONTEXT_MAX_QUEUED_RUNS_PER_USER;

  it("defaults to 20 and accepts 0 (unlimited)", () => {
    expect(schema.parse(undefined)).toBe(20);
    expect(schema.parse("0")).toBe(0);
  });

  it.each(["-1", "1.5", "ten"])("rejects %s", (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe("answer and version reuse caches", () => {
  it("are on by default with bounded sizes", () => {
    expect(serverVars.COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED.parse(undefined)).toBe(true);
    expect(serverVars.COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED.parse("false")).toBe(false);
    expect(serverVars.COCKPIT_CONTEXT_ANSWER_CACHE_TTL_SECONDS.parse(undefined)).toBe(3600);
    expect(serverVars.COCKPIT_CONTEXT_ANSWER_CACHE_MAX_ENTRIES.parse(undefined)).toBe(500);
    expect(serverVars.COCKPIT_CONTEXT_VERSION_CACHE_TTL_SECONDS.parse(undefined)).toBe(300);
    expect(serverVars.COCKPIT_CONTEXT_VERSION_CACHE_MAX_ENTRIES.parse(undefined)).toBe(1000);
  });

  it("refuses an unbounded size and a non-boolean flag", () => {
    expect(serverVars.COCKPIT_CONTEXT_ANSWER_CACHE_MAX_ENTRIES.safeParse("0").success).toBe(false);
    expect(serverVars.COCKPIT_CONTEXT_ANSWER_CACHE_ENABLED.safeParse("yes").success).toBe(false);
  });
});

describe("COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST", () => {
  const schema = serverVars.COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST;

  it("is empty by default", () => {
    expect(schema.parse(undefined)).toEqual([]);
    expect(schema.parse(" , ")).toEqual([]);
  });

  it("trims, lowercases, de-duplicates and sorts exact host names", () => {
    expect(
      schema.parse(" GitLab.Corp.Example ,gitea.internal.example,gitlab.corp.example"),
    ).toEqual(["gitea.internal.example", "gitlab.corp.example"]);
  });

  it.each([
    ["*.corp.example", "wildcards"],
    ["gitlab.corp.example:8443", "ports"],
    ["10.0.0.5", "IP literals"],
    ["[fd00::1]", "IPv6"],
    ["fd00::1", "IPv6"],
    ["gitlab", "fully qualified"],
    ["localhost", "localhost"],
    ["git.localhost", "localhost"],
    ["https://gitlab.corp.example", "URLs"],
    ["git@gitlab.corp.example", "URLs"],
    ["bad_host.example", "fully qualified"],
  ])("rejects %j", (value, reason) => {
    const result = schema.safeParse(value);
    expect(result.success).toBe(false);
    const message = result.error?.issues[0]?.message ?? "";
    expect(message).toContain("COCKPIT_CONTEXT_GIT_HOST_ALLOWLIST");
    expect(message).toContain(reason);
  });
});
