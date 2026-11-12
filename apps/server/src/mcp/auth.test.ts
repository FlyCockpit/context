import { createSign, generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpCredentialResult, McpIdentity } from "./credentials";

vi.mock("@cockpit-context/db", () => ({ default: {} }));

const { createMcpAdmissionGate } = await import("./admission");
const { createMcpRequestHandler, releaseWhenBodyEnds } = await import("./auth");

const ORIGIN = "http://localhost:3001";
const ISSUER = `${ORIGIN}/api/auth`;
const RESOURCE = `${ORIGIN}/mcp`;
const JWKS_URL = "http://127.0.0.1:3000/api/auth/jwks";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function b64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

/** An RS256 access JWT signed with the test key. */
function signJwt(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: ISSUER, aud: RESOURCE, iat: now, exp: now + 600, ...claims }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

const identity: McpIdentity = {
  userId: "user-a",
  credential: { kind: "agent_token", tokenId: "tok-1" },
  label: "Claude Code",
  allowPropose: true,
  autoApprove: false,
};

const authInstance = {
  options: {},
  $context: Promise.resolve({ baseURL: ISSUER, internalAdapter: {} }),
} as unknown as Parameters<typeof createMcpRequestHandler>[0]["authInstance"];

function setup(overrides: Partial<Parameters<typeof createMcpRequestHandler>[0]> = {}): {
  app: Hono;
  transport: { fetch: ReturnType<typeof vi.fn> };
  resolveAgentToken: ReturnType<typeof vi.fn>;
  resolveOauthClaims: ReturnType<typeof vi.fn>;
  onVerified: ReturnType<typeof vi.fn>;
} {
  const transport = {
    fetch: vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }))),
  };
  const resolveAgentToken = vi.fn(
    async (): Promise<McpCredentialResult> => ({ ok: true, identity }),
  );
  const resolveOauthClaims = vi.fn(
    async (): Promise<McpCredentialResult> => ({
      ok: true,
      identity: { ...identity, credential: { kind: "oauth", grantId: "g1", clientId: "c1" } },
    }),
  );
  const onVerified = vi.fn();
  const app = new Hono();
  app.post(
    "/mcp",
    createMcpRequestHandler({
      authInstance,
      transport,
      resourceUrl: RESOURCE,
      issuerUrl: ISSUER,
      jwksUrl: JWKS_URL,
      publicOrigin: ORIGIN,
      resolveAgentToken,
      resolveOauthClaims,
      consumeIdentityQuota: async () => ({ ok: true }),
      onVerified,
      ...overrides,
    }),
  );
  return { app, transport, resolveAgentToken, resolveOauthClaims, onVerified };
}

function post(
  app: Hono,
  authorization?: string,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" },
) {
  return app.request("http://internal:3000/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

const COCKPIT_CONTEXT_TOKEN = `cockpit_context_${"a".repeat(43)}`;

describe("createMcpRequestHandler", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === JWKS_URL) return Response.json({ keys: [jwk] });
        throw new Error(`unexpected fetch ${String(input)}`);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("answers a request without credentials with 401 and the resource metadata", async () => {
    const { app, transport } = setup();
    const response = await post(app);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("answers an unknown API token with 401 and the resource metadata", async () => {
    const { app, transport, resolveAgentToken } = setup();
    resolveAgentToken.mockResolvedValueOnce({
      ok: false,
      refusal: "unauthorized",
      reason: "unknown API token",
    });
    const response = await post(app, `Bearer ${COCKPIT_CONTEXT_TOKEN}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("takes the acting user from the credential, never from the request body", async () => {
    const { app, transport, resolveAgentToken, onVerified } = setup();
    const response = await post(app, `Bearer ${COCKPIT_CONTEXT_TOKEN}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "list_dependencies",
        arguments: { userId: "user-b" },
        _meta: { userId: "user-b" },
      },
    });
    expect(response.status).toBe(200);
    expect(resolveAgentToken).toHaveBeenCalledWith(COCKPIT_CONTEXT_TOKEN, expect.any(Date));
    expect(onVerified.mock.calls[0]?.[0].identity.userId).toBe("user-a");
    // The transport sees the request on the configured public origin, with the
    // verified AuthInfo the tools resolve their identity from.
    const [request, options] = transport.fetch.mock.calls[0] ?? [];
    expect((request as Request).url).toBe(`${ORIGIN}/mcp`);
    expect(options.authInfo).toBe(onVerified.mock.calls[0]?.[0].authInfo);
    expect(options.authInfo.token).not.toContain("cockpit_context_");
  });

  it("verifies an OAuth access token for the MCP audience and resolves its grant", async () => {
    const { app, transport, resolveOauthClaims, onVerified } = setup();
    const token = signJwt({
      sub: "user-a",
      azp: "c1",
      scope: "mcp offline_access",
      mcp_grant_id: "g1",
    });
    const response = await post(app, `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(resolveOauthClaims.mock.calls[0]?.[0]).toMatchObject({
      sub: "user-a",
      mcp_grant_id: "g1",
    });
    expect(onVerified.mock.calls[0]?.[0].identity.credential).toEqual({
      kind: "oauth",
      grantId: "g1",
      clientId: "c1",
    });
    expect(transport.fetch).toHaveBeenCalledOnce();
  });

  it("refuses an OAuth token minted for another audience", async () => {
    const { app, transport, resolveOauthClaims } = setup();
    const token = signJwt({
      sub: "user-a",
      azp: "c1",
      scope: "mcp",
      mcp_grant_id: "g1",
      aud: "http://elsewhere.test/mcp",
    });
    const response = await post(app, `Bearer ${token}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(resolveOauthClaims).not.toHaveBeenCalled();
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("refuses an OAuth token from another issuer, and a forged signature", async () => {
    const { app, resolveOauthClaims } = setup();
    const otherIssuer = signJwt({
      sub: "u",
      scope: "mcp",
      mcp_grant_id: "g1",
      iss: "http://evil.test",
    });
    expect((await post(app, `Bearer ${otherIssuer}`)).status).toBe(401);
    const good = signJwt({ sub: "u", scope: "mcp", mcp_grant_id: "g1" });
    const [header, , signature] = good.split(".");
    const tampered = `${header}.${b64url(JSON.stringify({ iss: ISSUER, aud: RESOURCE, sub: "admin", scope: "mcp", exp: 9_999_999_999 }))}.${signature}`;
    expect((await post(app, `Bearer ${tampered}`)).status).toBe(401);
    expect(resolveOauthClaims).not.toHaveBeenCalled();
  });

  it("refuses an OAuth token without the mcp scope with insufficient_scope", async () => {
    const { app, resolveOauthClaims } = setup();
    const token = signJwt({
      sub: "user-a",
      azp: "c1",
      scope: "offline_access",
      mcp_grant_id: "g1",
    });
    const response = await post(app, `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
    expect(resolveOauthClaims).not.toHaveBeenCalled();
  });

  it("answers a revoked grant with a bare 403 (no challenge)", async () => {
    const { app, resolveOauthClaims, transport } = setup();
    resolveOauthClaims.mockResolvedValueOnce({
      ok: false,
      refusal: "forbidden",
      reason: "grant missing, mismatched or revoked",
    });
    const token = signJwt({ sub: "user-a", azp: "c1", scope: "mcp", mcp_grant_id: "g1" });
    const response = await post(app, `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("answers 429 when the credential's request quota is spent", async () => {
    const { app, transport } = setup({
      consumeIdentityQuota: async () => ({ ok: false, retryAfterSeconds: 7 }),
    });
    const response = await post(app, `Bearer ${COCKPIT_CONTEXT_TOKEN}`);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("refuses new requests with 503 once shutdown closed the gate", async () => {
    const gate = createMcpAdmissionGate();
    await gate.close();
    const { app, resolveAgentToken } = setup({ admissionGate: gate });
    const response = await post(app, `Bearer ${COCKPIT_CONTEXT_TOKEN}`);
    expect(response.status).toBe(503);
    expect(resolveAgentToken).not.toHaveBeenCalled();
  });

  it("holds the permit until a streamed body is finished", async () => {
    const gate = createMcpAdmissionGate();
    let push: ((chunk: string) => void) | undefined;
    let end: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
        end = () => controller.close();
      },
    });
    const { app } = setup({
      admissionGate: gate,
      transport: { fetch: async () => new Response(stream) },
    });
    const response = await post(app, `Bearer ${COCKPIT_CONTEXT_TOKEN}`);
    expect(gate.outstanding).toBe(1);
    push?.("data: 1\n\n");
    end?.();
    expect(await response.text()).toBe("data: 1\n\n");
    expect(gate.outstanding).toBe(0);
  });
});

describe("releaseWhenBodyEnds", () => {
  it("releases at once for a bodiless response, and on cancel", async () => {
    const done = vi.fn();
    releaseWhenBodyEnds(new Response(null, { status: 204 }), done);
    expect(done).toHaveBeenCalledOnce();
    const cancelled = vi.fn();
    const wrapped = releaseWhenBodyEnds(new Response("abc"), cancelled);
    await wrapped.body?.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
