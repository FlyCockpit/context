import { beforeEach, describe, expect, it, vi } from "vitest";

import { anthropicSdkBaseUrl, createModelAdapter, resolvePromptCache } from "./adapters";
import type { AgentModel } from "./types";

// Capture the args each provider factory is called with so we can assert the config
// without reaching into adapter internals.
const calls: Record<"chat" | "responses" | "messages", unknown[][]> = {
  chat: [],
  responses: [],
  messages: [],
};

vi.mock("@tanstack/ai-openrouter", () => ({
  createOpenRouterText: (...args: unknown[]) => {
    calls.chat.push(args);
    return { name: "openrouter-chat" };
  },
  createOpenRouterResponsesText: (...args: unknown[]) => {
    calls.responses.push(args);
    return { name: "openrouter-responses" };
  },
}));
vi.mock("@tanstack/ai-anthropic", () => ({
  createAnthropicChat: (...args: unknown[]) => {
    calls.messages.push(args);
    return { name: "anthropic-messages" };
  },
}));

const claude = (api: AgentModel["api"]): AgentModel => ({
  api,
  model: "anthropic/claude-haiku-4.5",
  apiKey: "test-key",
});
const gpt = (api: AgentModel["api"]): AgentModel => ({
  api,
  model: "openai/gpt-4o",
  apiKey: "test-key",
});

beforeEach(() => {
  calls.chat.length = 0;
  calls.responses.length = 0;
  calls.messages.length = 0;
});

describe("createModelAdapter — chat-completions", () => {
  it("uses the OpenRouter chat adapter with no modelOptions (chat() promptCache does the caching)", () => {
    const bundle = createModelAdapter(claude("chat-completions"), { enabled: true, cacheKey: "k" });
    expect(bundle).toEqual({ adapter: { name: "openrouter-chat" } });
    expect(calls.chat[0]).toEqual([
      "anthropic/claude-haiku-4.5",
      "test-key",
      { retryConfig: { strategy: "none" } },
    ]);
  });

  it("forwards baseUrl as serverURL", () => {
    createModelAdapter({ ...gpt("chat-completions"), baseUrl: "https://proxy.example/api/v1" });
    expect(calls.chat[0]?.[2]).toEqual({
      retryConfig: { strategy: "none" },
      serverURL: "https://proxy.example/api/v1",
    });
  });
});

describe("createModelAdapter — responses", () => {
  it("adds top-level cache_control for Claude, plus the session and cache keys", () => {
    const bundle = createModelAdapter(claude("responses"), { enabled: true, cacheKey: "run-1" });
    expect(bundle.adapter).toEqual({ name: "openrouter-responses" });
    expect(bundle.modelOptions).toEqual({
      sessionId: "run-1",
      promptCacheKey: "run-1",
      cacheControl: { type: "ephemeral" },
    });
  });

  it("sends only the keys for a model that caches automatically", () => {
    const bundle = createModelAdapter(gpt("responses"), { enabled: true, cacheKey: "run-1" });
    expect(bundle.modelOptions).toEqual({ sessionId: "run-1", promptCacheKey: "run-1" });
  });

  it("clamps prompt_cache_key to 64 code points and keeps the full session id", () => {
    const key = "é".repeat(70);
    const bundle = createModelAdapter(gpt("responses"), { enabled: true, cacheKey: key });
    expect(bundle.modelOptions?.promptCacheKey).toBe("é".repeat(64));
    expect(bundle.modelOptions?.sessionId).toBe(key);
  });

  it("defaults caching on, and sends nothing when it is off", () => {
    expect(createModelAdapter(claude("responses")).modelOptions).toEqual({
      cacheControl: { type: "ephemeral" },
    });
    expect(createModelAdapter(gpt("responses")).modelOptions).toBeUndefined();
    expect(
      createModelAdapter(claude("responses"), { enabled: false, cacheKey: "k" }).modelOptions,
    ).toBeUndefined();
  });

  it("forwards baseUrl as serverURL", () => {
    createModelAdapter({ ...gpt("responses"), baseUrl: "http://localhost:4010/api/v1" });
    expect(calls.responses[0]?.[2]).toEqual({
      retryConfig: { strategy: "none" },
      serverURL: "http://localhost:4010/api/v1",
    });
  });
});

describe("createModelAdapter — messages", () => {
  it("uses the Anthropic adapter against OpenRouter's API root by default", () => {
    const bundle = createModelAdapter(claude("messages"), { enabled: true, cacheKey: "k" });
    expect(bundle).toEqual({ adapter: { name: "anthropic-messages" } });
    expect(calls.messages[0]?.slice(0, 2)).toEqual(["anthropic/claude-haiku-4.5", "test-key"]);
    expect(calls.messages[0]?.[2]).toEqual({
      baseURL: "https://openrouter.ai/api",
      maxRetries: 0,
      fetch: expect.any(Function),
    });
  });

  it("strips the /v1 the Anthropic SDK adds back", () => {
    createModelAdapter({ ...claude("messages"), baseUrl: "https://gateway.example/v1/" });
    expect(calls.messages[0]?.[2]).toMatchObject({ baseURL: "https://gateway.example" });
  });
});

describe("anthropicSdkBaseUrl", () => {
  it("rejects a base URL without a trailing /v1", () => {
    expect(() => anthropicSdkBaseUrl("https://gateway.example/api")).toThrow(/ends in \/v1/);
  });
});

describe("resolvePromptCache", () => {
  it("is short-lived and keyed by default, and 'none' when disabled", () => {
    expect(resolvePromptCache()).toBe("short");
    expect(resolvePromptCache({ enabled: true })).toBe("short");
    expect(resolvePromptCache({ enabled: true, cacheKey: "k" })).toEqual({
      retention: "short",
      key: "k",
    });
    expect(resolvePromptCache({ enabled: false, cacheKey: "k" })).toBe("none");
  });
});
