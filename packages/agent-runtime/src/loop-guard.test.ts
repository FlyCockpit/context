import { describe, expect, it, vi } from "vitest";

import {
  buildLoopCycleGuardMessage,
  buildLoopGuardMessage,
  callIdentity,
  canonicalizeArgs,
  LoopGuard,
  MAX_CYCLE_PERIOD,
} from "./loop-guard";

describe("canonicalizeArgs / callIdentity", () => {
  it("treats key-order variants as the same identity", () => {
    expect(callIdentity("t", { a: 1, b: 2 })).toBe(callIdentity("t", { b: 2, a: 1 }));
    expect(canonicalizeArgs({ z: 1, a: { y: 2, b: 3 } })).toEqual({
      a: { b: 3, y: 2 },
      z: 1,
    });
  });

  it("preserves array order (order is semantic)", () => {
    expect(callIdentity("t", { xs: [1, 2] })).not.toBe(callIdentity("t", { xs: [2, 1] }));
  });
});

describe("LoopGuard", () => {
  it("allows threshold executions then blocks with a synthesized message", () => {
    const guard = new LoopGuard(2);
    const names = ["fetch_page", "web_search", "write_row"];
    const args = { url: "https://example.com" };

    expect(guard.check("fetch_page", args, names)).toBeNull();
    expect(guard.check("fetch_page", args, names)).toBeNull();
    const blocked = guard.check("fetch_page", args, names);
    expect(blocked).not.toBeNull();
    expect(blocked).toContain('tool "fetch_page"');
    expect(blocked).toContain("web_search");
    expect(blocked).toContain("write_row");
    // Names only — never schemas.
    expect(blocked).not.toContain("inputSchema");
    expect(blocked).not.toContain("properties");
  });

  it("does not invoke side effects on a blocked call (caller responsibility)", () => {
    const guard = new LoopGuard(1);
    const execute = vi.fn();
    const names = ["t"];
    for (let i = 0; i < 3; i += 1) {
      const msg = guard.check("t", {}, names);
      if (msg === null) execute();
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("resets when a different call intervenes", () => {
    const guard = new LoopGuard(2);
    const names = ["a", "b"];
    expect(guard.check("a", { x: 1 }, names)).toBeNull();
    expect(guard.check("a", { x: 1 }, names)).toBeNull();
    // Different call resets.
    expect(guard.check("b", { x: 1 }, names)).toBeNull();
    expect(guard.check("a", { x: 1 }, names)).toBeNull();
    expect(guard.check("a", { x: 1 }, names)).toBeNull();
    // Still under threshold after reset.
    expect(guard.check("a", { x: 1 }, names)).not.toBeNull();
  });

  it("returns byte-identical messages for consecutive guarded rejections", () => {
    const guard = new LoopGuard(1);
    const names = ["only", "other"];
    guard.check("only", { n: 1 }, names);
    const first = guard.check("only", { n: 1 }, names);
    const second = guard.check("only", { n: 1 }, names);
    expect(first).toBe(second);
    expect(first).toBe(buildLoopGuardMessage("only", ["other"]));
  });

  it("is per-instance — concurrent loops do not share state", () => {
    const a = new LoopGuard(1);
    const b = new LoopGuard(1);
    const names = ["t"];
    expect(a.check("t", {}, names)).toBeNull();
    expect(b.check("t", {}, names)).toBeNull();
    expect(a.check("t", {}, names)).not.toBeNull();
    // b still has one free execution after a blocked.
    expect(b.check("t", {}, names)).not.toBeNull();
  });

  it("matches key-order-insensitive args as the same identity", () => {
    const guard = new LoopGuard(1);
    const names = ["t"];
    expect(guard.check("t", { a: 1, b: 2 }, names)).toBeNull();
    expect(guard.check("t", { b: 2, a: 1 }, names)).not.toBeNull();
  });
});

describe("LoopGuard — repeating cycles", () => {
  const names = ["web_search", "fetch_page", "write_row"];

  it("blocks a two-call alternating cycle after threshold + 1 full repetitions", () => {
    const guard = new LoopGuard(2);
    const a = () => guard.check("web_search", { query: "x" }, names);
    const b = () => guard.check("fetch_page", { url: "https://a.test" }, names);
    // Two full repetitions are still allowed (a retry after a fetch is normal).
    expect(a()).toBeNull();
    expect(b()).toBeNull();
    expect(a()).toBeNull();
    expect(b()).toBeNull();
    // The third repetition closes the cycle and is blocked.
    expect(a()).toBeNull();
    const blocked = b();
    expect(blocked).not.toBeNull();
    expect(blocked).toContain('"fetch_page"');
    expect(blocked).toContain("web_search");
    expect(blocked).toBe(buildLoopCycleGuardMessage("fetch_page", ["web_search", "write_row"], 2));
  });

  it("keeps blocking as the model keeps re-issuing the cycle, with stable bytes", () => {
    const guard = new LoopGuard(2);
    const results: Array<string | null> = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(guard.check("a", { n: 1 }, ["a", "b"]));
      results.push(guard.check("b", { n: 2 }, ["a", "b"]));
    }
    const blocked = results.filter((message): message is string => message !== null);
    expect(blocked.length).toBeGreaterThan(4);
    expect(new Set(blocked).size).toBe(2); // one stable message per tool name
  });

  it("blocks a three-call cycle too", () => {
    const guard = new LoopGuard(2);
    const calls: Array<[string, unknown]> = [
      ["web_search", { query: "q" }],
      ["fetch_page", { url: "u" }],
      ["write_row", { row: { id: 1 } }],
    ];
    let blocked: string | null = null;
    for (let i = 0; i < 9; i += 1) {
      const [name, args] = calls[i % 3]!;
      blocked = guard.check(name, args, names);
      if (i < 8) expect(blocked, `call ${i}`).toBeNull();
    }
    expect(blocked).not.toBeNull();
  });

  it("does not detect cycles longer than MAX_CYCLE_PERIOD (varied work stays unblocked)", () => {
    const guard = new LoopGuard(2);
    const period = MAX_CYCLE_PERIOD + 1;
    for (let i = 0; i < period * 6; i += 1) {
      expect(guard.check("web_search", { query: `q${i % period}` }, names), `call ${i}`).toBeNull();
    }
  });

  it("never blocks a genuinely varied sequence of high-recall search calls", () => {
    const guard = new LoopGuard(2);
    // The exact pattern high-recall discovery needs: the same tool, re-queried with
    // different limits, date windows, and domain filters, interleaved with fetches.
    const searches = [
      { query: "dentists in springfield", limit: 50 },
      { query: "dentists in springfield", limit: 100 },
      { query: "dentists in springfield", tbs: "qdr:y" },
      { query: "dentists in springfield", tbs: "qdr:m" },
      { query: "dentists in springfield", includeDomains: ["yelp.com"] },
      { query: "dentists in springfield", includeDomains: ["healthgrades.com"] },
      { query: "springfield dental clinics" },
      { query: "springfield orthodontists" },
      { query: "springfield periodontists" },
      { query: "dental practices springfield il" },
    ];
    searches.forEach((args, index) => {
      expect(guard.check("web_search", args, names), JSON.stringify(args)).toBeNull();
      expect(guard.check("fetch_page", { url: `https://example.test/${index}` }, names)).toBeNull();
    });
    // And paging a stored result at advancing offsets is not a cycle either.
    for (let offset = 0; offset < 8; offset += 1) {
      expect(
        guard.check("retrieve_tool_result", { id: "r1", offset: offset * 4000 }, names),
      ).toBeNull();
    }
  });

  it("does not treat a single repeated identity as a cycle (rule 1 owns that case)", () => {
    // Threshold 2 → the third consecutive identical call is blocked by the consecutive
    // rule, with the consecutive-rule message, not the cycle message.
    const guard = new LoopGuard(2);
    expect(guard.check("t", {}, ["t", "u"])).toBeNull();
    expect(guard.check("t", {}, ["t", "u"])).toBeNull();
    expect(guard.check("t", {}, ["t", "u"])).toBe(buildLoopGuardMessage("t", ["u"]));
  });
});
