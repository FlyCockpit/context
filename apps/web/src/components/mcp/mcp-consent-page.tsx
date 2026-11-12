import { Button } from "@cockpit-context/ui/components/button";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Check, Globe, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { FlagSwitches } from "@/components/access/flag-switches";
import { AuthCard, AuthScreen } from "@/components/auth/auth-screen";
import { ClientTile } from "@/components/mcp/client-tile";
import { useAuthSession } from "@/hooks/use-auth-session";
import { type ConnectionFlags, consentCapabilities, normalizeFlags } from "@/lib/access";
import { authClient } from "@/lib/auth-client";
import {
  isLoopbackHost,
  parseMcpOAuthSearch,
  resolveOauthRedirectUrl,
  signedRedirectHost,
  toMcpPublicClientInfo,
} from "@/lib/mcp-oauth-search";

/**
 * The MCP OAuth consent page (docs/mcp.md), ported from
 * ws-model-proxy.
 *
 * Shows the client's name (from the session-authenticated
 * `/oauth2/public-client`, display-safe fields only), the host the answer
 * returns to (the SIGNED `redirect_uri`, never the client's self-declared
 * URL), what the agent can and cannot do, and the connection's two flags
 * (the same `FlagSwitches` as the create-token dialog). Approve and Deny both post to
 * `/oauth2/consent`; the signed `oauth_query` is attached by
 * `oauthProviderClient()`. The flags travel in the same body and the
 * server records them on the grant before the code reaches the browser
 * (packages/auth/src/mcp-consent-flags.ts). The page navigates only on a
 * server answer with `redirect: true` and a `url`.
 */

type Phase = "review" | "submitting" | "denied" | "invalid";

/** Better-Auth's consent body plus the two flags its schema does not declare. */
type ConsentBody = NonNullable<Parameters<typeof authClient.oauth2.consent>[0]> & {
  allowPropose?: boolean;
  autoApprove?: boolean;
};

export function McpConsentPage({ rawSearch }: { rawSearch: string }) {
  const { t } = useTranslation(["auth"]);
  const info = parseMcpOAuthSearch(rawSearch);
  const redirectHost = signedRedirectHost(rawSearch);
  const [phase, setPhase] = useState<Phase>("review");
  const session = useAuthSession();
  // The person's choice only, never read from the URL the client built.
  const [flags, setFlags] = useState<ConnectionFlags>({ allowPropose: true, autoApprove: false });

  const client = useQuery({
    queryKey: ["mcp-consent-client", info.clientId, rawSearch],
    enabled: info.usable,
    retry: false,
    queryFn: async () => {
      const result = await authClient.oauth2.publicClient({
        query: { client_id: info.clientId ?? "" },
      });
      if (result.error) throw result.error;
      return toMcpPublicClientInfo(result.data);
    },
  });

  const submit = async (accept: boolean) => {
    setPhase("submitting");
    try {
      const body: ConsentBody = accept ? { accept, ...normalizeFlags(flags) } : { accept };
      const result = await authClient.oauth2.consent(body);
      const url = result.error ? null : resolveOauthRedirectUrl(result.data);
      if (url !== null) {
        window.location.assign(url);
        return;
      }
      setPhase(accept || result.error ? "invalid" : "denied");
    } catch {
      setPhase("invalid");
    }
  };

  if (phase === "denied") {
    return (
      <AuthCard
        title={t("auth:mcpConsent.deniedTitle")}
        description={t("auth:mcpConsent.deniedDescription")}
      >
        {null}
      </AuthCard>
    );
  }
  if (
    phase === "invalid" ||
    !info.usable ||
    redirectHost === null ||
    client.isError ||
    (client.isSuccess && client.data === null)
  ) {
    return (
      <AuthCard
        title={t("auth:mcpConsent.invalidTitle")}
        description={t("auth:mcpConsent.invalidDescription")}
      >
        {null}
      </AuthCard>
    );
  }
  if (client.isPending || phase === "submitting") {
    return (
      <AuthScreen>
        <div className="w-full max-w-md space-y-4">
          <Skeleton className="mx-auto h-8 w-48" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthScreen>
    );
  }

  const clientName =
    client.data?.name ?? client.data?.clientId ?? t("auth:mcpConsent.unknownClient");
  const email = session.state.status === "authenticated" ? session.state.session.user.email : null;
  return (
    <AuthCard
      title={t("auth:mcpConsent.title")}
      description={
        email ? (
          <span className="block min-w-0 break-words">
            {t("auth:mcpConsent.signedInAs", { email })}
          </span>
        ) : (
          t("auth:mcpConsent.description")
        )
      }
    >
      <ClientTile name={clientName} caption={t("auth:mcpConsent.wantsAccess")} />
      <div className="flex min-w-0 items-start gap-2 text-sm">
        <Globe aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-0.5">
          {/* The host wraps as one unit (it breaks inside only when it is
              wider than the line), so a phone never shows "12 / 7.0.0.1". */}
          <p className="min-w-0 break-words text-muted-foreground">
            {t("auth:mcpConsent.returnsTo")}{" "}
            <span
              className="inline-block max-w-full break-all font-mono font-medium text-foreground"
              data-testid="redirect-host"
            >
              {redirectHost}
            </span>
          </p>
          {isLoopbackHost(redirectHost) ? (
            <p className="text-xs text-pretty text-muted-foreground">
              {t("auth:mcpConsent.loopbackHint")}
            </p>
          ) : null}
        </div>
      </div>
      <div className="grid min-w-0 gap-3 rounded-lg border p-3 text-sm sm:grid-cols-2">
        <CapabilityList
          title={t("auth:mcpConsent.canTitle")}
          items={consentCapabilities(flags).map((key) => t(`auth:mcpConsent.can.${key}`))}
          allowed
        />
        <CapabilityList
          title={t("auth:mcpConsent.cannotTitle")}
          items={[t("auth:mcpConsent.cannot.settings")]}
          allowed={false}
        />
      </div>
      <FlagSwitches
        variant="form"
        value={flags}
        onChange={setFlags}
        disabled={phase !== "review"}
      />
      <p className="text-xs text-pretty text-muted-foreground">{t("auth:mcpConsent.manageNote")}</p>
      <div className="space-y-2">
        <Button className="min-h-[44px] w-full" onClick={() => void submit(true)}>
          {t("auth:mcpConsent.accept")}
        </Button>
        <Button
          variant="outline"
          className="min-h-[44px] w-full"
          onClick={() => void submit(false)}
        >
          {t("auth:mcpConsent.deny")}
        </Button>
      </div>
    </AuthCard>
  );
}

function CapabilityList({
  title,
  items,
  allowed,
}: {
  title: string;
  items: string[];
  allowed: boolean;
}) {
  const Icon = allowed ? Check : X;
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item} className="flex min-w-0 items-start gap-2">
            <Icon
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-4 shrink-0",
                allowed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 text-pretty">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
