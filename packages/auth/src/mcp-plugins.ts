import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { jwt } from "better-auth/plugins";
import {
  canonicalMcpResource,
  MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
  MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES,
  MCP_METADATA_PROFILE,
  MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS,
  MCP_REFRESH_RETRY_WINDOW_SECONDS,
  MCP_SCOPES,
  mcpConsentPagePath,
  mcpLoginPagePath,
} from "./mcp-config";
import { mcpConsentFlags } from "./mcp-consent-flags";
import { createMcpPostLoginOptions, issueMcpGrantClaims } from "./mcp-grant";

/**
 * The Better-Auth plugins behind Cockpit Context's MCP OAuth (docs/mcp.md),
 * ported from ws-model-proxy's `resolveMcpPlugins` on better-auth 1.7.9:
 *
 * - `jwt()` signs self-contained access JWTs for the MCP resource. Session
 *   payloads are never signed into headers (`disableSettingJwtHeader`): the
 *   option exists for exactly this composition with an OAuth provider.
 * - `mcp()` IS the OAuth provider (never compose a separate
 *   `oauthProvider()`), so every provider option is passed flat here.
 * - `mcpConsentFlags()` records the consent page's two flags on the grant.
 * - `cimd()` resolves Client ID Metadata Document clients through the
 *   hardened Node transport (resolve-once DNS, public-address checks,
 *   connection pinning, size and time limits, no redirects).
 *
 * The OAuth surface is `/api/auth/oauth2/*` plus `/api/auth/jwks`; the
 * discovery documents are forwarded from `/.well-known/*`
 * (apps/server/src/mcp/discovery.ts).
 */
export function resolveMcpPlugins({ baseUrl, secret }: { baseUrl: string; secret: string }) {
  // `mcp()` validates the resource (HTTPS, or HTTP on loopback for local
  // dev), audience-binds issued tokens to it and links it into newly
  // registered clients.
  const resource = canonicalMcpResource(baseUrl);
  const loginPage = mcpLoginPagePath();
  const postLogin = createMcpPostLoginOptions({ secret, loginPage });

  return [
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      resource,
      loginPage,
      consentPage: mcpConsentPagePath(),
      postLogin,
      // The login page may show display-safe client data before sign-in; the
      // endpoint still requires a valid signed `oauth_query`.
      allowPublicClientPrelogin: true,
      scopes: [...MCP_SCOPES],
      clientRegistrationDefaultScopes: [...MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES],
      clientRegistrationAllowedScopes: [],
      // PKCE for every registered client, public or confidential.
      clientRegistrationRequirePKCE: true,
      // RFC 7591 dynamic registration, unauthenticated (MCP clients register
      // without an initial credential). The server mounts a whole-service
      // registration limiter in front of it (apps/server/src/mcp/oauth-limits.ts).
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // A registration that omits `application_type` is validated as a
      // native client: coding agents (Claude Code, Codex, Cursor) register
      // an `http://localhost:<port>/callback` loopback redirect without one,
      // which the OIDC "web" default refuses. Native rules still allow https
      // redirects (claude.ai) and private-use schemes, refuse http anywhere
      // but the exact loopback hosts, and PKCE is required either way.
      clientRegistrationDefaultApplicationType: "native",
      // User-bound tools only: authorization code + rotating refresh.
      grantTypes: ["authorization_code", "refresh_token"],
      accessTokenExpiresIn: MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
      refreshTokenExpiresIn: MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS,
      refreshTokenReuseInterval: MCP_REFRESH_RETRY_WINDOW_SECONDS,
      // A client must be linked to the MCP resource to get tokens for it.
      enforcePerClientResources: true,
      // No user-facing OAuth client/resource CRUD.
      clientPrivileges: () => false,
      resourcePrivileges: () => false,
      // Stamps the immutable grant id (`mcp_grant_id`) and refuses issuance
      // for a revoked grant (mcp-grant.ts). Throws, so no token is minted
      // without a live grant decision.
      extensions: [
        {
          claims: {
            accessToken: (input: {
              grantType?: string | undefined;
              user?: { id?: string | undefined } | null;
              client: { clientId: string };
              sessionId?: string | null | undefined;
              referenceId?: string | undefined;
            }) =>
              issueMcpGrantClaims({
                grantType: input.grantType,
                userId: input.user?.id,
                clientId: input.client.clientId,
                referenceId: input.referenceId,
                sessionId: input.sessionId,
                secret,
              }),
          },
        },
      ],
    }),
    mcpConsentFlags({ secret }),
    cimd({ fetchClientMetadataResource, metadataProfile: MCP_METADATA_PROFILE }),
  ];
}
