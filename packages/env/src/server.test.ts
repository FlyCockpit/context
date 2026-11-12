import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cockpitContextRateBudgetEnvDefaults } from "./rate-budgets.js";

// server.ts validates process.env and runs its startup guards as import-time
// side effects, so every case re-imports a freshly reset module under a fully
// controlled environment. The helper snapshots and restores process.env so
// cases cannot leak state into each other or the surrounding test run.

type EnvMap = Record<string, string | undefined>;

// A syntactically valid keyring (`v1:` + base64 of 32 bytes). Built at runtime
// so no key-shaped literal sits in the source.
const TEST_KEYRING = `v1:${Buffer.alloc(32, 7).toString("base64")}`;

const BASE_ENV: EnvMap = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://localhost:5432/test",
  // Strong enough for the entropy check: >10 distinct characters, no
  // placeholder words, no repeating pattern.
  BETTER_AUTH_SECRET: "kV3mQ7xZ2bN9wL5pR8tY4cJ6hF1dS0gU",
  // https, so the production-only http:// guards stay out of the way.
  BETTER_AUTH_URL: "https://app.example.com",
  // Every optional key the startup guards read starts explicitly undefined,
  // so a value exported in the developer's shell cannot skew a case.
  ADMIN_EMAILS: undefined,
  SIGNUP_ENABLED: undefined,
  SSO_ENABLED: undefined,
  SSO_CLIENT_ID: undefined,
  SSO_CLIENT_SECRET: undefined,
  SSO_ISSUER: undefined,
  FORCE_SSO: undefined,
  SMTP_HOST: undefined,
  SMTP_FROM: undefined,
  DATABASE_POOL_MAX: undefined,
  // Required in production; present so the non-Cockpit Context production cases boot.
  COCKPIT_CONTEXT_ENCRYPTION_KEYS: TEST_KEYRING,
  COCKPIT_CONTEXT_DATA_DIR: undefined,
  COCKPIT_CONTEXT_MODEL: undefined,
  COCKPIT_CONTEXT_HELPER_MODEL: undefined,
  COCKPIT_CONTEXT_MODEL_API: undefined,
  COCKPIT_CONTEXT_OPENROUTER_BASE_URL: undefined,
  OPENROUTER_API_KEY: undefined,
  // The Cockpit Context rate budgets (./rate-budgets.ts), so a shell export cannot skew them.
  ...Object.fromEntries(
    Object.keys(cockpitContextRateBudgetEnvDefaults()).map((key) => [key, undefined]),
  ),
};

const ENV_SNAPSHOT: EnvMap = { ...process.env };

async function importServerEnv(overrides: EnvMap = {}): Promise<typeof import("./server.js")> {
  const effective: EnvMap = { ...BASE_ENV, ...overrides };
  for (const [key, value] of Object.entries(effective)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await import("./server.js");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in ENV_SNAPSHOT)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(ENV_SNAPSHOT)) {
      process.env[key] = value;
    }
  }
}

function lockoutMessage(warn: Mock) {
  return warn.mock.calls.some((call) =>
    call.join(" ").includes("SIGNUP_ENABLED=false and ADMIN_EMAILS is empty"),
  );
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server env — rate-limit budget defaults", () => {
  it("defaults every budget to its family reference (collapse is behavior-neutral)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(mod.env.RATE_LIMIT_AUTH_POINTS).toBe(30);
    expect(mod.env.RATE_LIMIT_AUTH_WINDOW_SECONDS).toBe(60);
    expect(mod.env.RATE_LIMIT_RPC_POINTS).toBe(100);
    expect(mod.env.RATE_LIMIT_RPC_WINDOW_SECONDS).toBe(60);
    expect(mod.env.RATE_LIMIT_EMAIL_POINTS).toBe(3);
    expect(mod.env.RATE_LIMIT_EMAIL_WINDOW_SECONDS).toBe(3600);
  });

  it("accepts 0 points for RATE_LIMIT_EMAIL_POINTS — the documented family disable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ RATE_LIMIT_EMAIL_POINTS: "0" });
    expect(mod.env.RATE_LIMIT_EMAIL_POINTS).toBe(0);
  });

  it("rejects a non-positive budget points/window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(importServerEnv({ RATE_LIMIT_AUTH_POINTS: "0" })).rejects.toThrow();
    await expect(importServerEnv({ RATE_LIMIT_AUTH_WINDOW_SECONDS: "0" })).rejects.toThrow();
  });
});

describe("shared env — DATABASE_POOL_MAX", () => {
  it("defaults to the node-postgres default of 10", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(mod.env.DATABASE_POOL_MAX).toBe(10);
  });

  it("accepts a positive integer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ DATABASE_POOL_MAX: "25" });
    expect(mod.env.DATABASE_POOL_MAX).toBe(25);
  });

  it("rejects zero, negative, and non-numeric values", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(importServerEnv({ DATABASE_POOL_MAX: "0" })).rejects.toThrow();
    await expect(importServerEnv({ DATABASE_POOL_MAX: "-5" })).rejects.toThrow();
    await expect(importServerEnv({ DATABASE_POOL_MAX: "many" })).rejects.toThrow();
  });
});

describe("server env startup guards — admin lockout", () => {
  it("warns (never throws) in production when signup is disabled and ADMIN_EMAILS is unset — provisioned installs keep their DB admins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ NODE_ENV: "production" });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(true);
  });

  it("treats an empty-string ADMIN_EMAILS as unset (lockout still warns)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ NODE_ENV: "production", ADMIN_EMAILS: "" });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(true);
  });

  it("still warns with SSO fully configured — SSO is not an admin escape hatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({
      NODE_ENV: "production",
      SSO_ENABLED: "true",
      SSO_CLIENT_ID: "client-id",
      SSO_CLIENT_SECRET: "sS0oW9eA1kZ3cR4eT5vB6nM7qP8xY2zQ4uV0wE",
      SSO_ISSUER: "https://sso.example.com",
      FORCE_SSO: "true",
    });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(true);
  });

  it("boots in production with open signup and no SMTP, warning that email is unverified", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      importServerEnv({ NODE_ENV: "production", SIGNUP_ENABLED: "true" }),
    ).resolves.toBeDefined();
    expect(
      warn.mock.calls.some((call) =>
        call.join(" ").includes("open signup creates accounts without email verification"),
      ),
    ).toBe(true);
  });

  it("does not throw when SIGNUP_ENABLED=true (the signup path exists)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({
      NODE_ENV: "production",
      SIGNUP_ENABLED: "true",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "App <no-reply@example.com>",
    });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(false);
    // The pre-existing non-lockout warning still fires for this shape.
    expect(
      warn.mock.calls.some((call) =>
        call.join(" ").includes("no new admin can use the bootstrap signup path"),
      ),
    ).toBe(true);
  });

  it("does not throw in dev — the lockout shape only warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ NODE_ENV: "development" });
    expect(mod.ADMIN_EMAILS.size).toBe(0);
    expect(lockoutMessage(warn)).toBe(true);
  });

  it("boots fine with a populated ADMIN_EMAILS, trimmed and lowercased", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({
      NODE_ENV: "production",
      ADMIN_EMAILS: "  Admin@Example.com , ,bob@example.com  ",
    });
    expect(mod.ADMIN_EMAILS).toEqual(new Set(["admin@example.com", "bob@example.com"]));
    expect(warn.mock.calls.some((call) => call.join(" ").includes("ADMIN_EMAILS"))).toBe(false);
  });
});

describe("server env — resolveAppName", () => {
  it("defaults to App when unset or empty (Docker exports empty-string ARGs)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(mod.resolveAppName(undefined)).toBe("Cockpit Context");
    expect(mod.resolveAppName("")).toBe("Cockpit Context");
  });

  it("passes through a configured name via the canonical web schema", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(mod.resolveAppName("Acme")).toBe("Acme");
  });

  it("fails fast on names the client schema rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(() => mod.resolveAppName("x".repeat(81))).toThrow();
  });
});

describe("server env startup guards — SSO_CLIENT_SECRET entropy", () => {
  const STRONG_SSO_SECRET = "sS0oW9eA1kZ3cR4eT5vB6nM7qP8xY2zQ4uV0wE";

  function ssoWarning(warn: Mock) {
    return warn.mock.calls.some((call) => call.join(" ").includes("SSO_CLIENT_SECRET is weak"));
  }

  // One import per case: server.ts runs its guards as import-time side
  // effects, so a second import in the same test would hit the module cache
  // and never re-run them.
  it.each([["changeme"], ["my-secret-value"], ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]])(
    "warns in dev for placeholder SSO secret %s",
    async (placeholder) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await importServerEnv({ NODE_ENV: "development", SSO_CLIENT_SECRET: placeholder });
      expect(ssoWarning(warn)).toBe(true);
    },
  );

  it("throws in production for placeholder SSO secrets", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      importServerEnv({ NODE_ENV: "production", SSO_CLIENT_SECRET: "changeme" }),
    ).rejects.toThrowError("SSO_CLIENT_SECRET is weak");
  });

  it("stays silent when SSO_CLIENT_SECRET is unset (SSO inert)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await importServerEnv({ NODE_ENV: "development" });
    expect(ssoWarning(warn)).toBe(false);
  });

  it("stays silent for a strong SSO secret in dev and prod", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await importServerEnv({
      NODE_ENV: "development",
      SSO_CLIENT_SECRET: STRONG_SSO_SECRET,
    });
    expect(ssoWarning(warn)).toBe(false);
    warn.mockClear();
    const mod = await importServerEnv({
      NODE_ENV: "production",
      ADMIN_EMAILS: "admin@example.com",
      SSO_CLIENT_SECRET: STRONG_SSO_SECRET,
    });
    expect(mod.env.SSO_CLIENT_SECRET).toBe(STRONG_SSO_SECRET);
    expect(ssoWarning(warn)).toBe(false);
  });
});

describe("server env — Cockpit Context", () => {
  it("applies the documented defaults", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv();
    expect(mod.env.COCKPIT_CONTEXT_MAX_STORAGE_GB).toBe(20);
    expect(mod.env.COCKPIT_CONTEXT_MAX_ITERATIONS).toBe(100);
    expect(mod.env.COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS).toBe(600);
    expect(mod.env.COCKPIT_CONTEXT_MODEL_STALL_SECONDS).toBe(90);
    expect(mod.env.COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS).toBe(4);
    expect(mod.env.COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER).toBe(3);
    expect(mod.env.COCKPIT_CONTEXT_MCP_WAIT_SECONDS).toBe(900);
    expect(mod.env.COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS).toBe(300);
    expect(mod.env.COCKPIT_CONTEXT_LSP_IDLE_SECONDS).toBe(30);
    expect(mod.env.COCKPIT_CONTEXT_LSP_MAX_SERVERS).toBe(4);
    expect(mod.env.COCKPIT_CONTEXT_LSP_SANDBOX).toBe("required");
    expect(mod.env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS).toBe(90);
    expect(mod.env.COCKPIT_CONTEXT_OPERATOR_NAME).toBeUndefined();
    expect(mod.env.COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL).toBeUndefined();
    // Every rate budget boots at its shipped count.
    for (const [key, value] of Object.entries(cockpitContextRateBudgetEnvDefaults())) {
      expect(mod.env[key as keyof typeof mod.env]).toBe(value);
    }
  });

  it("reads a rate budget override and refuses to boot on a 0 or malformed one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await importServerEnv({
      COCKPIT_CONTEXT_RUNS_PER_HOUR: "5",
      COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR: "",
    });
    expect(mod.env.COCKPIT_CONTEXT_RUNS_PER_HOUR).toBe(5);
    expect(mod.env.COCKPIT_CONTEXT_MCP_QUERIES_PER_HOUR).toBe(30);

    for (const raw of ["0", "1.5", "lots"]) {
      vi.resetModules();
      error.mockClear();
      await expect(
        importServerEnv({ COCKPIT_CONTEXT_STEERS_PER_10_MINUTES: raw }),
      ).rejects.toThrow();
      // The startup error names the variable and why.
      expect(JSON.stringify(error.mock.calls)).toContain(
        "COCKPIT_CONTEXT_STEERS_PER_10_MINUTES must be a whole number from 1 to 100000",
      );
    }
  });

  it("accepts only `required` and `off` for COCKPIT_CONTEXT_LSP_SANDBOX", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const off = await importServerEnv({ COCKPIT_CONTEXT_LSP_SANDBOX: "off" });
    expect(off.env.COCKPIT_CONTEXT_LSP_SANDBOX).toBe("off");
    vi.resetModules();
    await expect(importServerEnv({ COCKPIT_CONTEXT_LSP_SANDBOX: "optional" })).rejects.toThrow();
  });

  it("accepts 0 as 'keep conversations' and rejects negative or fractional retention", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const keep = await importServerEnv({ COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: "0" });
    expect(keep.env.COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS).toBe(0);
    vi.resetModules();
    await expect(
      importServerEnv({ COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: "-1" }),
    ).rejects.toThrow();
    vi.resetModules();
    await expect(
      importServerEnv({ COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS: "1.5" }),
    ).rejects.toThrow();
  });

  it("trims the operator identity and rejects a contact that is not an email", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await importServerEnv({
      COCKPIT_CONTEXT_OPERATOR_NAME: "  Example Co. ",
      COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL: " privacy@example.com ",
    });
    expect(mod.env.COCKPIT_CONTEXT_OPERATOR_NAME).toBe("Example Co.");
    expect(mod.env.COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL).toBe("privacy@example.com");
    vi.resetModules();
    await expect(
      importServerEnv({ COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL: "not-an-email" }),
    ).rejects.toThrow();
  });

  it("defaults the data dir to /data in production", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await importServerEnv({ NODE_ENV: "production", ADMIN_EMAILS: "a@example.com" });
    expect(mod.COCKPIT_CONTEXT_DATA_DIR).toBe("/data");
  });

  it("falls back to COCKPIT_CONTEXT_MODEL for the helper model", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const same = await importServerEnv({ COCKPIT_CONTEXT_MODEL: "vendor/main" });
    expect(same.COCKPIT_CONTEXT_HELPER_MODEL).toBe("vendor/main");
    vi.resetModules();
    const split = await importServerEnv({
      COCKPIT_CONTEXT_MODEL: "vendor/main",
      COCKPIT_CONTEXT_HELPER_MODEL: "vendor/small",
    });
    expect(split.COCKPIT_CONTEXT_HELPER_MODEL).toBe("vendor/small");
  });

  it("requires COCKPIT_CONTEXT_ENCRYPTION_KEYS in production and only warns in dev", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      importServerEnv({ NODE_ENV: "production", COCKPIT_CONTEXT_ENCRYPTION_KEYS: undefined }),
    ).rejects.toThrowError("COCKPIT_CONTEXT_ENCRYPTION_KEYS is not set");
    vi.resetModules();
    await importServerEnv({ NODE_ENV: "development", COCKPIT_CONTEXT_ENCRYPTION_KEYS: undefined });
    expect(
      warn.mock.calls.some((call) =>
        call.join(" ").includes("COCKPIT_CONTEXT_ENCRYPTION_KEYS is not set"),
      ),
    ).toBe(true);
  });

  it("rejects a malformed keyring without echoing it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const malformed = "v1:not-a-real-key-value";
    const failure = await importServerEnv({ COCKPIT_CONTEXT_ENCRYPTION_KEYS: malformed }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("not-a-real-key-value");
  });

  it("requires COCKPIT_CONTEXT_MODEL once OPENROUTER_API_KEY is set in production", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      importServerEnv({ NODE_ENV: "production", OPENROUTER_API_KEY: "or-test" }),
    ).rejects.toThrowError("COCKPIT_CONTEXT_MODEL");
    vi.resetModules();
    const mod = await importServerEnv({
      NODE_ENV: "production",
      ADMIN_EMAILS: "a@example.com",
      OPENROUTER_API_KEY: "or-test",
      COCKPIT_CONTEXT_MODEL: "vendor/main",
    });
    expect(mod.env.COCKPIT_CONTEXT_MODEL).toBe("vendor/main");
  });

  it("refuses an http OpenRouter base URL in production but allows it in dev", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      importServerEnv({
        NODE_ENV: "production",
        COCKPIT_CONTEXT_OPENROUTER_BASE_URL: "http://localhost:4010/api/v1",
      }),
    ).rejects.toThrowError("COCKPIT_CONTEXT_OPENROUTER_BASE_URL must use https");
    vi.resetModules();
    const mod = await importServerEnv({
      COCKPIT_CONTEXT_OPENROUTER_BASE_URL: "http://localhost:4010/api/v1",
    });
    expect(mod.env.COCKPIT_CONTEXT_OPENROUTER_BASE_URL).toBe("http://localhost:4010/api/v1");
  });

  it("defaults the model API to chat-completions and refuses an unknown one", async () => {
    expect((await importServerEnv()).env.COCKPIT_CONTEXT_MODEL_API).toBe("chat-completions");
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(importServerEnv({ COCKPIT_CONTEXT_MODEL_API: "completions" })).rejects.toThrow();
  });

  it("requires a /v1 base URL for the messages API", async () => {
    await expect(
      importServerEnv({
        COCKPIT_CONTEXT_MODEL_API: "messages",
        COCKPIT_CONTEXT_OPENROUTER_BASE_URL: "https://gateway.example/api",
      }),
    ).rejects.toThrowError("ends in /v1");
    vi.resetModules();
    const mod = await importServerEnv({
      COCKPIT_CONTEXT_MODEL_API: "messages",
      COCKPIT_CONTEXT_OPENROUTER_BASE_URL: "https://gateway.example/api/v1/",
    });
    expect(mod.env.COCKPIT_CONTEXT_MODEL_API).toBe("messages");
  });
});
