import assert from "node:assert/strict";
import { test } from "node:test";
import { sendBackupHeartbeat } from "../backup-heartbeat.mjs";

test("heartbeat sends only when configured and accepts successful upload pings", async () => {
  let calls = 0;
  const options = {
    fetcher: async () => {
      calls += 1;
      return { ok: true };
    },
    log() {},
  };
  assert.equal(await sendBackupHeartbeat({ ...options, raw: "" }), false);
  assert.equal(calls, 0);
  assert.equal(
    await sendBackupHeartbeat({ ...options, raw: "https://heartbeat.example.test/token" }),
    true,
  );
  assert.equal(calls, 1);
});

test("heartbeat retries without ever logging token-bearing errors", async () => {
  const logs = [];
  let attempts = 0;
  const result = await sendBackupHeartbeat({
    raw: "https://heartbeat.example.test/private-token",
    fetcher: async () => {
      attempts += 1;
      throw new Error("private-token https://secret.example.test");
    },
    sleep: async () => {},
    warn: (message) => logs.push(message),
  });
  assert.equal(result, false);
  assert.equal(attempts, 3);
  assert.doesNotMatch(logs.join("\n"), /private-token|secret\.example/);
});
