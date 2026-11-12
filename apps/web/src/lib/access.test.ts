import { describe, expect, it } from "vitest";

import {
  claudeOAuthCommand,
  claudeTokenCommand,
  codexOAuthCommand,
  codexTokenCommand,
  consentCapabilities,
  expiryFromChoice,
  hostLabel,
  mcpJsonConfig,
  normalizeFlags,
  parseKnownHostsSearch,
  parseScanTarget,
} from "@/lib/access";

const NOW = Date.parse("2026-10-01T00:00:00Z");

describe("expiryFromChoice", () => {
  it("returns null for never and a future date otherwise", () => {
    expect(expiryFromChoice("never", NOW)).toBeNull();
    expect(expiryFromChoice("d7", NOW)?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(expiryFromChoice("d90", NOW)?.toISOString()).toBe("2026-12-30T00:00:00.000Z");
  });

  it("keeps a year inside the server's 365-day cap", () => {
    const year = expiryFromChoice("y1", NOW);
    expect(year).not.toBeNull();
    expect((year?.getTime() ?? 0) - NOW).toBeLessThan(365 * 86_400_000);
  });
});

describe("normalizeFlags", () => {
  it("drops auto-approve when proposing is off", () => {
    expect(normalizeFlags({ allowPropose: false, autoApprove: true })).toEqual({
      allowPropose: false,
      autoApprove: false,
    });
    expect(normalizeFlags({ allowPropose: true, autoApprove: true })).toEqual({
      allowPropose: true,
      autoApprove: true,
    });
  });
});

describe("consentCapabilities", () => {
  it("never claims less than the chosen flags grant", () => {
    expect(consentCapabilities({ allowPropose: false, autoApprove: false })).toEqual([
      "list",
      "ask",
    ]);
    expect(consentCapabilities({ allowPropose: true, autoApprove: false })).toEqual([
      "list",
      "ask",
      "propose",
    ]);
    expect(consentCapabilities({ allowPropose: true, autoApprove: true })).toEqual([
      "list",
      "ask",
      "autoAdd",
    ]);
    // Auto-approve without proposing grants nothing extra (normalizeFlags).
    expect(consentCapabilities({ allowPropose: false, autoApprove: true })).toEqual([
      "list",
      "ask",
    ]);
  });
});

describe("agent config snippets", () => {
  const url = "https://cockpit-context.example.com/mcp";
  const secret = "cockpit_context_abc-DEF_123";

  it("builds the Claude Code commands", () => {
    expect(claudeOAuthCommand(url)).toBe(
      "claude mcp add --transport http cockpit-context https://cockpit-context.example.com/mcp",
    );
    expect(claudeTokenCommand(url, secret)).toBe(
      'claude mcp add --transport http cockpit-context https://cockpit-context.example.com/mcp --header "Authorization: Bearer cockpit_context_abc-DEF_123"',
    );
  });

  it("quotes a URL a shell would split", () => {
    expect(claudeOAuthCommand("http://localhost:3001/mcp?x=1&y=2")).toBe(
      "claude mcp add --transport http cockpit-context 'http://localhost:3001/mcp?x=1&y=2'",
    );
  });

  it("builds Codex OAuth and environment-token commands", () => {
    expect(codexOAuthCommand(url)).toBe(
      `codex mcp add cockpit-context --url ${url}\ncodex mcp login cockpit-context`,
    );
    expect(codexTokenCommand(url, secret)).toBe(
      `export COCKPIT_CONTEXT_TOKEN=${secret}\ncodex mcp add cockpit-context --url ${url} --bearer-token-env-var COCKPIT_CONTEXT_TOKEN`,
    );
  });

  it("quotes Codex URLs and token values as single shell arguments", () => {
    expect(codexTokenCommand("https://example.com/mcp?x=1&y=2", "a'b")).toBe(
      "export COCKPIT_CONTEXT_TOKEN='a'\\''b'\ncodex mcp add cockpit-context --url 'https://example.com/mcp?x=1&y=2' --bearer-token-env-var COCKPIT_CONTEXT_TOKEN",
    );
  });

  it("builds the generic JSON config", () => {
    expect(JSON.parse(mcpJsonConfig(url, secret))).toEqual({
      mcpServers: {
        "cockpit-context": { type: "http", url, headers: { Authorization: `Bearer ${secret}` } },
      },
    });
  });
});

describe("parseScanTarget", () => {
  it.each([
    ["git.example.com", { host: "git.example.com", port: 22 }],
    ["  Git.Example.COM ", { host: "git.example.com", port: 22 }],
    ["git.example.com:2222", { host: "git.example.com", port: 2222 }],
    ["git@git.example.com:team/repo.git", { host: "git.example.com", port: 22 }],
    ["ssh://git@git.example.com:2222/team/repo.git", { host: "git.example.com", port: 2222 }],
    ["ssh://git.example.com/team/repo.git", { host: "git.example.com", port: 22 }],
    ["[2001:db8::1]:2200", { host: "[2001:db8::1]", port: 2200 }],
  ])("reads %s", (input, expected) => {
    expect(parseScanTarget(input, 22)).toEqual(expected);
  });

  it("keeps the port field's value when the input names none", () => {
    expect(parseScanTarget("git.example.com", 2022)).toEqual({
      host: "git.example.com",
      port: 2022,
    });
  });

  it.each(["", "   ", "exa mple.com", "host:99999", "[::1", "https://x.example/ü"])(
    "refuses %j",
    (input) => {
      expect(parseScanTarget(input, 22)).toBeNull();
    },
  );
});

describe("hostLabel", () => {
  it("hides the default port", () => {
    expect(hostLabel("git.example.com", 22)).toBe("git.example.com");
    expect(hostLabel("git.example.com", 2222)).toBe("git.example.com:2222");
  });
});

describe("parseKnownHostsSearch", () => {
  it("keeps a host and a valid port", () => {
    expect(parseKnownHostsSearch({ host: " git.example.com ", port: 2222 })).toEqual({
      host: "git.example.com",
      port: 2222,
    });
    expect(parseKnownHostsSearch({ host: "git.example.com", port: "2200" })).toEqual({
      host: "git.example.com",
      port: 2200,
    });
  });

  it("drops anything else", () => {
    expect(parseKnownHostsSearch({})).toEqual({});
    expect(parseKnownHostsSearch({ port: 22 })).toEqual({});
    expect(parseKnownHostsSearch({ host: "x.example", port: 0 })).toEqual({ host: "x.example" });
    expect(parseKnownHostsSearch({ host: "x.example", port: "abc" })).toEqual({
      host: "x.example",
    });
    expect(parseKnownHostsSearch({ host: 5 })).toEqual({});
  });
});
