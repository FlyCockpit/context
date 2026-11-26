import { Button } from "@cockpit-context/ui/components/button";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthCard, AuthScreen } from "@/components/auth/auth-screen";
import { ONE_TIME_CODE_LENGTH, OneTimeCodeField } from "@/components/auth/plain-field";
import { ClientTile } from "@/components/mcp/client-tile";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import { clearServerFieldError, setServerFieldError } from "@/lib/form-server-error";
import {
  mcpPageHref,
  parseMcpOAuthSearch,
  resolveOauthRedirectUrl,
  toMcpPublicClientInfo,
} from "@/lib/mcp-oauth-search";
import { friendly, isCodeRejection, isCredentialRejection } from "@/utils/friendly-error";

/**
 * The MCP OAuth login page: Better-Auth's `loginPage` and `postLogin.page`
 * (packages/auth/src/mcp-plugins.ts). Ported from ws-model-proxy.
 *
 * - Anonymous: the client's display-safe name (POST
 *   `/oauth2/public-client-prelogin`, which requires a valid signed query),
 *   then email + password and, when asked, a 2FA code. Each request carries
 *   the signed `oauth_query` (`oauthProviderClient()`), so a successful
 *   sign-in answers with the next step of the authorization — usually the
 *   consent page — and the page follows it.
 * - Signed in: Continue (to consent, with the raw signed query), or sign
 *   out and sign in again. A revoked connection lands here: a fresh session
 *   is a new grant.
 */
export function McpLoginPage({ lang, rawSearch }: { lang: string; rawSearch: string }) {
  const { t } = useTranslation(["auth"]);
  const info = parseMcpOAuthSearch(rawSearch);
  const { state } = useAuthSession();

  if (!info.usable) return <InvalidRequestCard />;
  if (state.status === "pending" || state.status === "error") return <PageSkeleton />;
  if (state.status === "authenticated") {
    return (
      <AuthCard
        title={t("auth:mcpLogin.signedInTitle")}
        description={t("auth:mcpLogin.signedInDescription", { email: state.session.user.email })}
      >
        <Button
          className="min-h-[44px] w-full"
          onClick={() => window.location.assign(mcpPageHref(lang, "mcp-consent", rawSearch))}
        >
          {t("auth:mcpLogin.continue")}
        </Button>
        <Button
          variant="outline"
          className="min-h-[44px] w-full"
          onClick={() => void authClient.signOut()}
        >
          {t("auth:mcpLogin.switchAccount")}
        </Button>
      </AuthCard>
    );
  }
  return <McpSignIn lang={lang} rawSearch={rawSearch} clientId={info.clientId ?? ""} />;
}

function InvalidRequestCard() {
  const { t } = useTranslation(["auth"]);
  return (
    <AuthCard
      title={t("auth:mcpLogin.invalidTitle")}
      description={t("auth:mcpLogin.invalidDescription")}
    >
      {null}
    </AuthCard>
  );
}

function PageSkeleton() {
  return (
    <AuthScreen>
      <div className="w-full max-w-md space-y-4">
        <Skeleton className="mx-auto h-8 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </AuthScreen>
  );
}

/** Follow Better-Auth's next step, or fall back to the consent page. */
function continueAuthorization(data: unknown, lang: string, rawSearch: string) {
  window.location.assign(
    resolveOauthRedirectUrl(data) ?? mcpPageHref(lang, "mcp-consent", rawSearch),
  );
}

/**
 * The MCP 2FA step. `error` is the inline message under the code field (a
 * rejected code), cleared by the next edit; Cancel resets the whole object.
 */
const initialMcpTwoFactorState = {
  active: false,
  code: "",
  busy: false,
  error: null as string | null,
};
type McpTwoFactorState = typeof initialMcpTwoFactorState;

function McpSignIn({
  lang,
  rawSearch,
  clientId,
}: {
  lang: string;
  rawSearch: string;
  clientId: string;
}) {
  const { t } = useTranslation(["auth"]);
  const [twoFactor, setTwoFactor] = useState<McpTwoFactorState>(initialMcpTwoFactorState);
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const prelogin = useQuery({
    queryKey: ["mcp-prelogin-client", clientId, rawSearch],
    retry: false,
    queryFn: async () => {
      const result = await authClient.oauth2.publicClientPrelogin({ client_id: clientId });
      if (result.error) throw result.error;
      return toMcpPublicClientInfo(result.data);
    },
  });

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      let result: Awaited<ReturnType<typeof authClient.signIn.email>>;
      try {
        result = await authClient.signIn.email({
          email: value.email,
          password: value.password,
        });
      } catch (err) {
        // The request itself failed (server unreachable, offline): say so,
        // and the same credentials can be sent again.
        toast.error(friendly(err));
        return;
      }
      if (result.error) {
        if (!isCredentialRejection(result.error)) {
          // Not about either field (rate limit, server or network trouble):
          // a toast with what happened, and the same credentials can be sent
          // again.
          toast.error(friendly(result.error));
          return;
        }
        // Under the password (the field the user retypes), never saying which
        // of the two was wrong; editing either field clears it.
        setServerFieldError(form, "password", t("auth:errors.invalidCredentials"));
        passwordInput.current?.focus();
        passwordInput.current?.select();
        return;
      }
      if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        setTwoFactor({ ...initialMcpTwoFactorState, active: true });
        return;
      }
      continueAuthorization(result.data, lang, rawSearch);
    },
    validators: {
      onSubmit: z.object({ email: z.email(), password: z.string().min(1) }),
    },
  });

  const verifyTwoFactor = async () => {
    if (twoFactor.busy) return;
    setTwoFactor((current) => ({ ...current, busy: true, error: null }));
    try {
      const result = await authClient.twoFactor.verifyTotp({ code: twoFactor.code });
      if (result.error) {
        if (isCodeRejection(result.error)) {
          // A wrong or expired code: under the field, with the code kept and
          // selected so typing replaces it.
          setTwoFactor((current) => ({
            ...current,
            busy: false,
            error: t("auth:errors.invalidTotp"),
          }));
          codeInput.current?.focus();
          codeInput.current?.select();
          return;
        }
        // A rate limit, lockout or server failure says what happened, and the
        // code stays to resend.
        toast.error(friendly(result.error));
        setTwoFactor((current) => ({ ...current, busy: false }));
        return;
      }
      continueAuthorization(result.data, lang, rawSearch);
    } catch (err) {
      toast.error(friendly(err));
      setTwoFactor((current) => ({ ...current, busy: false }));
    }
  };

  if (prelogin.isError) return <InvalidRequestCard />;
  const clientName = prelogin.data?.name ?? prelogin.data?.clientId ?? null;

  if (twoFactor.active) {
    return (
      <AuthCard title={t("auth:twoFactor.title")} description={t("auth:twoFactor.description")}>
        <OneTimeCodeField
          id="mcp-totp-code"
          label={t("auth:fields.verificationCode")}
          value={twoFactor.code}
          error={twoFactor.error}
          inputRef={codeInput}
          // Typing replaces the code and drops the previous rejection.
          onValueChange={(code) => setTwoFactor((current) => ({ ...current, code, error: null }))}
          onComplete={() => void verifyTwoFactor()}
        />
        <Button
          className="min-h-[44px] w-full"
          disabled={twoFactor.code.length !== ONE_TIME_CODE_LENGTH || twoFactor.busy}
          onClick={() => void verifyTwoFactor()}
        >
          {twoFactor.busy ? t("auth:twoFactor.verifying") : t("auth:twoFactor.verify")}
        </Button>
        <Button
          variant="ghost"
          className="min-h-[44px] w-full"
          disabled={twoFactor.busy}
          // Back to the credential form with nothing carried over, so the next
          // sign-in (maybe another account) starts clean.
          onClick={() => setTwoFactor(initialMcpTwoFactorState)}
        >
          {t("auth:twoFactor.cancel")}
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("auth:mcpLogin.title")} description={t("auth:mcpLogin.description")}>
      {clientName ? (
        <ClientTile name={clientName} caption={t("auth:mcpLogin.clientCaption")} />
      ) : prelogin.isPending ? (
        <Skeleton className="h-[4.125rem] w-full rounded-lg" />
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          form.handleSubmit();
        }}
        className="space-y-4"
      >
        <form.Field
          name="email"
          // A wrong email or password is shown under the password; fixing only
          // the email must make the form submittable again.
          listeners={{ onChange: () => clearServerFieldError(form, "password") }}
        >
          {(field) => (
            <TextField
              field={field}
              label={t("auth:fields.email")}
              type="email"
              autoComplete="email"
            />
          )}
        </form.Field>
        <form.Field name="password">
          {(field) => (
            <TextField
              field={field}
              ref={passwordInput}
              label={t("auth:fields.password")}
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.Field>
        <form.Subscribe
          selector={(formState) => ({
            canSubmit: formState.canSubmit,
            isSubmitting: formState.isSubmitting,
          })}
        >
          {({ canSubmit, isSubmitting }) => (
            <Button
              type="submit"
              className="min-h-[44px] w-full"
              disabled={!canSubmit || isSubmitting}
            >
              {isSubmitting ? t("auth:login.signingIn") : t("auth:login.signIn")}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthCard>
  );
}
