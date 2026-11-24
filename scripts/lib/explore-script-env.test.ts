import assert from "node:assert/strict";
import { test } from "node:test";

import { readExploreScriptEnv } from "./explore-script-env.ts";

const base = { OPENROUTER_API_KEY: "test-key", COCKPIT_CONTEXT_MODEL: "vendor/model" };

test("defaults the API to chat-completions, as the server does", () => {
  assert.deepEqual(readExploreScriptEnv(base), {
    ok: true,
    value: { apiKey: "test-key", model: "vendor/model", api: "chat-completions" },
  });
});

test("honors COCKPIT_CONTEXT_MODEL_API for every API", () => {
  for (const api of ["chat-completions", "responses", "messages"]) {
    const result = readExploreScriptEnv({ ...base, COCKPIT_CONTEXT_MODEL_API: ` ${api} ` });
    assert.equal(result.ok && result.value.api, api);
  }
});

test("refuses an API the runtime does not speak", () => {
  const result = readExploreScriptEnv({ ...base, COCKPIT_CONTEXT_MODEL_API: "completions" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /chat-completions, responses, messages.*completions/);
});

test("needs a key and a model", () => {
  assert.equal(readExploreScriptEnv({ COCKPIT_CONTEXT_MODEL: "m" }).ok, false);
  assert.equal(
    readExploreScriptEnv({ OPENROUTER_API_KEY: "k", COCKPIT_CONTEXT_MODEL: " " }).ok,
    false,
  );
});

test("reads the optional settings, ignoring blanks and non-positive numbers", () => {
  assert.deepEqual(
    readExploreScriptEnv({
      ...base,
      COCKPIT_CONTEXT_HELPER_MODEL: "vendor/helper",
      COCKPIT_CONTEXT_OPENROUTER_BASE_URL: "http://localhost:4010/api/v1",
      COCKPIT_CONTEXT_MAX_ITERATIONS: "12",
      COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS: "90",
      COCKPIT_CONTEXT_MAX_PARALLEL_HELPERS: "3",
      COCKPIT_CONTEXT_MAX_HELPERS: "6",
    }),
    {
      ok: true,
      value: {
        apiKey: "test-key",
        model: "vendor/model",
        api: "chat-completions",
        helperModel: "vendor/helper",
        baseUrl: "http://localhost:4010/api/v1",
        maxIterations: 12,
        timeoutSeconds: 90,
        maxParallelHelpers: 3,
        maxHelpers: 6,
      },
    },
  );
  const blank = readExploreScriptEnv({
    ...base,
    COCKPIT_CONTEXT_HELPER_MODEL: "",
    COCKPIT_CONTEXT_MAX_ITERATIONS: "0",
    COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS: "1.5",
    COCKPIT_CONTEXT_MAX_PARALLEL_HELPERS: "0",
    COCKPIT_CONTEXT_MAX_HELPERS: "x",
  });
  assert.deepEqual(blank, {
    ok: true,
    value: { apiKey: "test-key", model: "vendor/model", api: "chat-completions" },
  });
});
