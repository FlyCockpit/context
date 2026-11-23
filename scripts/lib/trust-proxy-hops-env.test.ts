import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTrustProxyHops, looksDeployed } from "./trust-proxy-hops-env.ts";

const PUBLIC = "https://context.example.com";

test("warns for 0 or unset hops on a production or public https deployment", () => {
  for (const env of [
    { NODE_ENV: "production", TRUST_PROXY_HOPS: "0" },
    { NODE_ENV: "production" },
    { BETTER_AUTH_URL: PUBLIC },
    { BETTER_AUTH_URL: PUBLIC, TRUST_PROXY_HOPS: " 0 " },
  ]) {
    const verdict = checkTrustProxyHops(env);
    assert.equal(verdict.status, "warn", JSON.stringify(env));
    assert.match(verdict.hint ?? "", /Cloudflare Tunnel/);
  }
});

test("is ok once hops are set on a deployment", () => {
  assert.deepEqual(checkTrustProxyHops({ BETTER_AUTH_URL: PUBLIC, TRUST_PROXY_HOPS: "1" }), {
    status: "ok",
    detail: "1 trusted proxy hop",
  });
  assert.equal(
    checkTrustProxyHops({ NODE_ENV: "production", TRUST_PROXY_HOPS: "2" }).detail,
    "2 trusted proxy hops",
  );
});

test("does not warn in local development", () => {
  for (const url of [
    "http://localhost:3000",
    "https://cockpit-context.localhost",
    "https://localhost:8443",
    "https://127.0.0.1:8443",
    "https://[::1]:8443",
    "http://context.example.com",
    "not a url",
    undefined,
  ]) {
    assert.equal(checkTrustProxyHops({ BETTER_AUTH_URL: url }).status, "ok", String(url));
  }
  assert.equal(
    looksDeployed({ NODE_ENV: "development", BETTER_AUTH_URL: "http://localhost" }),
    false,
  );
});

test("leaves an invalid value to the env schema check", () => {
  for (const value of ["-1", "1.5", "two"]) {
    assert.equal(
      checkTrustProxyHops({ NODE_ENV: "production", TRUST_PROXY_HOPS: value }).status,
      "ok",
    );
  }
});
