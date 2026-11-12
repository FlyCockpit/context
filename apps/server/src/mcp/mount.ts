import { canonicalMcpIssuer, canonicalMcpResource } from "@cockpit-context/auth/mcp-config";
import prisma from "@cockpit-context/db";
import type { Env, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RateLimiterRes } from "rate-limiter-flexible";

import { resolveClientIp } from "../client-ip.js";
import { createRateLimiterMiddleware, mcpIdentityLimiter, mcpIpLimiter } from "../rate-limit.js";
import { sessionMiddleware } from "../session-middleware.js";
import { createMcpAdmissionGate } from "./admission";
import { createMcpRequestHandler, type McpAuthInstance, type McpQuotaResult } from "./auth";
import { createMcpAuthorizeGuard, MCP_AUTHORIZE_PATH } from "./authorize-guard";
import { resolveAgentToken, resolveOauthClaims } from "./credentials";
import { createMcpDiscoveryForwarder, MCP_WELL_KNOWN_PATHS } from "./discovery";
import { errorClass } from "./errors";
import { createMcpTransport, MCP_MAX_REQUEST_BODY_BYTES } from "./handler";
import {
  MCP_OAUTH_CONSENT_MAX_BODY_BYTES,
  MCP_OAUTH_CONSENT_PATH,
  MCP_OAUTH_CONTINUE_PATH,
  MCP_OAUTH_FORM_MAX_BODY_BYTES,
  MCP_OAUTH_REGISTER_PATH,
  MCP_OAUTH_TOKEN_PATH,
  mcpOauthBodyCap,
  mcpOauthRateLimits,
  mcpRegistrationLimit,
  onMcpOauthRoute,
} from "./oauth-routes";
import { bindMcpToolDispatch } from "./tool-dispatch";

/**
 * Wiring of the MCP server into the Hono app (docs/mcp.md). Two
 * calls from apps/server/src/index.ts:
 *
 * - {@link mountMcpEndpoints}, before CORS: the discovery documents and
 *   `/mcp` (method gate → pre-auth IP limiter → 1 MB body cap → handler).
 * - {@link mountMcpOauthGuards}, before the general `/api/auth/*` limiter:
 *   body caps, the MCP OAuth buckets and the authorize boundary.
 */

const MCP_ENDPOINT_PATH = "/mcp";

export interface McpEndpoints {
  /** Stop admitting, cancel in-flight calls, close the transport. */
  close(): Promise<void>;
}

/** POST only; everything else is 405 before authentication. */
const mcpMethodGate: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "POST") return c.newResponse(null, 405, { Allow: "POST" });
  return next();
};

const mcpBodyCap: MiddlewareHandler = bodyLimit({
  maxSize: MCP_MAX_REQUEST_BODY_BYTES,
  onError: (c) =>
    c.json(
      { jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null },
      413,
    ),
});

async function consumeIdentityQuota(key: string): Promise<McpQuotaResult> {
  try {
    await mcpIdentityLimiter.consume(key);
    return { ok: true };
  } catch (rejection) {
    if (rejection instanceof RateLimiterRes) {
      return { ok: false, retryAfterSeconds: Math.ceil(rejection.msBeforeNext / 1000) };
    }
    // Fail-closed: the surface spends model budget.
    console.error(`[mcp] identity limiter failed, failing closed (${errorClass(rejection)})`);
    return { ok: false, retryAfterSeconds: 60 };
  }
}

export function mountMcpEndpoints<E extends Env>(
  app: Hono<E>,
  options: {
    auth: McpAuthInstance & { handler: (request: Request) => Promise<Response> };
    baseUrl: string;
    secret: string;
    /** The port this process listens on: the verifier fetches the JWKS over loopback. */
    port: number;
  },
): McpEndpoints {
  for (const path of MCP_WELL_KNOWN_PATHS) {
    app.all(
      path,
      createMcpDiscoveryForwarder({
        publicOrigin: options.baseUrl,
        handler: (request) => options.auth.handler(request),
      }),
    );
  }

  const admissionGate = createMcpAdmissionGate();
  const transport = createMcpTransport({ isShuttingDown: () => admissionGate.closed });
  app.use(MCP_ENDPOINT_PATH, mcpMethodGate);
  app.use(
    MCP_ENDPOINT_PATH,
    createRateLimiterMiddleware(mcpIpLimiter, {
      failClosed: true,
      resolveKey: (c) => `ip:${resolveClientIp(c)}`,
    }),
  );
  app.use(MCP_ENDPOINT_PATH, mcpBodyCap);
  app.post(
    MCP_ENDPOINT_PATH,
    createMcpRequestHandler({
      authInstance: options.auth,
      transport,
      resourceUrl: canonicalMcpResource(options.baseUrl),
      issuerUrl: canonicalMcpIssuer(options.baseUrl).replace(/\/$/, ""),
      // Loopback, not the public URL: a container often cannot reach its
      // own public hostname, and the keys are this process's anyway.
      jwksUrl: `http://127.0.0.1:${options.port}/api/auth/jwks`,
      publicOrigin: options.baseUrl,
      resolveAgentToken: (token, now) =>
        resolveAgentToken(token, { prisma, secret: options.secret, now }),
      resolveOauthClaims: (claims, now) => resolveOauthClaims(claims, { prisma, now }),
      consumeIdentityQuota,
      admissionGate,
      onVerified: ({ authInfo, identity, requestId, signal }) =>
        bindMcpToolDispatch(authInfo, { identity, requestId, signal }),
    }),
  );

  return {
    async close() {
      await admissionGate.close();
      await transport.close();
    },
  };
}

export function mountMcpOauthGuards<E extends Env>(
  app: Hono<E>,
  options: { baseUrl: string },
): void {
  // Resolve the session on consent/continue only, so their bucket can key
  // on the user (Better-Auth still does its own lookup).
  for (const path of [MCP_OAUTH_CONSENT_PATH, MCP_OAUTH_CONTINUE_PATH]) {
    app.use(path, onMcpOauthRoute("POST", path, sessionMiddleware));
  }
  // Body caps before the limiters, so an oversized request burns no budget.
  app.use(
    MCP_AUTHORIZE_PATH,
    onMcpOauthRoute("POST", MCP_AUTHORIZE_PATH, mcpOauthBodyCap(MCP_OAUTH_FORM_MAX_BODY_BYTES)),
  );
  app.use(
    MCP_OAUTH_TOKEN_PATH,
    onMcpOauthRoute("POST", MCP_OAUTH_TOKEN_PATH, mcpOauthBodyCap(MCP_OAUTH_FORM_MAX_BODY_BYTES)),
  );
  app.use(
    MCP_OAUTH_CONSENT_PATH,
    onMcpOauthRoute(
      "POST",
      MCP_OAUTH_CONSENT_PATH,
      mcpOauthBodyCap(MCP_OAUTH_CONSENT_MAX_BODY_BYTES),
    ),
  );
  app.use(
    MCP_OAUTH_REGISTER_PATH,
    onMcpOauthRoute(
      "POST",
      MCP_OAUTH_REGISTER_PATH,
      mcpOauthBodyCap(MCP_OAUTH_CONSENT_MAX_BODY_BYTES),
    ),
  );
  app.use(
    MCP_OAUTH_REGISTER_PATH,
    onMcpOauthRoute("POST", MCP_OAUTH_REGISTER_PATH, mcpRegistrationLimit),
  );
  app.use("/api/auth/*", mcpOauthRateLimits);
  app.use(MCP_AUTHORIZE_PATH, createMcpAuthorizeGuard(options.baseUrl));
}
