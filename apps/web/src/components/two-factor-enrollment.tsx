import { Button } from "@cockpit-context/ui/components/button";
import { toast } from "@cockpit-context/ui/components/sileo";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthCard } from "@/components/auth/auth-screen";
import { TwoFactorSetupDetails } from "@/components/two-factor-setup-details";
import { authClient } from "@/lib/auth-client";
import { setServerFieldError } from "@/lib/form-server-error";
import { friendly, isCodeRejection, isRateLimit } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

/** Better-Auth's answer to a wrong current password on `twoFactor.enable`. */
function isWrongPassword(error: { code?: string; status?: number }): boolean {
  return error.code === "INVALID_PASSWORD";
}

/**
 * One enrollment flow for settings and the forced-enrollment takeover. A wrong
 * password or code is said under its field (focus goes back to it), and every
 * step has Cancel, which returns to the start and forgets the unconfirmed
 * secret, so nobody is stuck halfway through.
 */
export function TwoFactorEnrollment() {
  const { t } = useTranslation(["auth", "settings", "common"]);
  const [step, setStep] = useState<"intro" | "password" | "backup" | "verify">("intro");
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  // The passwordless sentence is only true where SSO sign-in exists.
  const { data: appConfig } = useQuery(orpc.appConfig.queryOptions());
  const passwordForm = useForm({
    defaultValues: { password: "" },
    // SSO-only accounts have no password; Better Auth accepts an empty one for
    // passwordless enrollment (allowPasswordless), so the field stays optional.
    validators: { onSubmit: z.object({ password: z.string() }) },
    onSubmit: async ({ value }) => {
      try {
        const result = await authClient.twoFactor.enable({
          password: value.password,
          method: "totp",
        });
        if (result.error && isWrongPassword(result.error)) {
          setServerFieldError(passwordForm, "password", t("auth:errors.invalidPassword"));
          passwordInput.current?.focus();
          passwordInput.current?.select();
          return;
        }
        if (result.error || result.data?.method !== "totp") {
          toast.error(
            result.error && isRateLimit(result.error)
              ? friendly(result.error)
              : t("auth:twoFactor.couldNotStartSetup"),
          );
          return;
        }
        setSetup({ totpURI: result.data.totpURI, backupCodes: result.data.backupCodes });
        passwordForm.reset();
        setStep("backup");
      } catch {
        toast.error(t("auth:twoFactor.couldNotStartSetup"));
      }
    },
  });
  const verifyForm = useForm({
    defaultValues: { code: "" },
    validators: { onSubmit: z.object({ code: z.string().regex(/^\d{6}$/) }) },
    onSubmit: async ({ value }) => {
      try {
        const result = await authClient.twoFactor.verifyTotp({ code: value.code });
        if (result.error) {
          // Only a wrong or expired code goes under the field (which blocks
          // resubmitting until it is edited). A rate limit, lockout or server
          // failure is not the code's fault: a toast, and the same code can be
          // sent again.
          if (!isCodeRejection(result.error)) {
            toast.error(friendly(result.error));
            return;
          }
          setServerFieldError(verifyForm, "code", t("auth:errors.invalidTotp"));
          codeInput.current?.focus();
          codeInput.current?.select();
          return;
        }
        // Refresh the document and all session-derived gates after enrollment.
        window.location.reload();
      } catch (err) {
        toast.error(friendly(err));
      }
    },
  });

  // Back to the start from any step: nothing typed and no unconfirmed secret
  // is kept (Better-Auth only turns 2FA on after the code is verified).
  const cancel = () => {
    passwordForm.reset();
    verifyForm.reset();
    setSetup(null);
    setStep("intro");
  };

  if (step === "intro") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("auth:twoFactor.introText")}</p>
        <Button size="touch" onClick={() => setStep("password")}>
          {t("auth:twoFactor.setUp")}
        </Button>
      </div>
    );
  }

  if (step === "password") {
    return (
      <form
        className="max-w-sm space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          passwordForm.handleSubmit();
        }}
      >
        <p className="text-sm text-muted-foreground">{t("auth:twoFactor.passwordPrompt")}</p>
        {appConfig?.ssoEnabled === true && (
          <p className="text-sm text-muted-foreground">{t("auth:twoFactor.passwordlessPrompt")}</p>
        )}
        <passwordForm.Field name="password">
          {(field) => (
            <TextField
              field={field}
              ref={passwordInput}
              label={t("auth:fields.password")}
              type="password"
              autoComplete="current-password"
            />
          )}
        </passwordForm.Field>
        <passwordForm.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <div className="flex gap-2">
              <Button size="touch" type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? t("auth:twoFactor.settingUp") : t("auth:twoFactor.continue")}
              </Button>
              <Button
                size="touch"
                type="button"
                variant="ghost"
                disabled={isSubmitting}
                onClick={cancel}
              >
                {t("common:actions.cancel")}
              </Button>
            </div>
          )}
        </passwordForm.Subscribe>
      </form>
    );
  }

  return (
    <div className="max-w-sm space-y-4">
      {setup && (
        <TwoFactorSetupDetails
          backupCodes={setup.backupCodes}
          backupCodesLabel={t("auth:twoFactor.backupCodesLabel")}
          manualPrompt={t("auth:twoFactor.addKeyToApp")}
          qrPrompt={t("auth:twoFactor.scanQrPrompt")}
          totpURI={setup.totpURI}
        />
      )}
      {step === "backup" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="touch" onClick={() => setStep("verify")}>
            {t("settings:security.savedBackupCodes")}
          </Button>
          <Button size="touch" type="button" variant="ghost" onClick={cancel}>
            {t("common:actions.cancel")}
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            verifyForm.handleSubmit();
          }}
        >
          <verifyForm.Field name="code">
            {(field) => (
              <TextField
                field={field}
                ref={codeInput}
                label={t("auth:fields.verificationCode")}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                inputClassName="text-center text-lg tracking-widest"
              />
            )}
          </verifyForm.Field>
          <verifyForm.Subscribe
            selector={(state) => ({
              canSubmit: state.canSubmit,
              isSubmitting: state.isSubmitting,
              code: state.values.code,
            })}
          >
            {({ canSubmit, isSubmitting, code }) => (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="touch"
                  type="submit"
                  disabled={!canSubmit || !/^\d{6}$/.test(code) || isSubmitting}
                >
                  {isSubmitting
                    ? t("auth:twoFactor.verifying")
                    : t("auth:twoFactor.verifyAndEnable")}
                </Button>
                <Button
                  size="touch"
                  type="button"
                  variant="ghost"
                  disabled={isSubmitting}
                  onClick={cancel}
                >
                  {t("common:actions.cancel")}
                </Button>
              </div>
            )}
          </verifyForm.Subscribe>
        </form>
      )}
    </div>
  );
}

export function TwoFactorSetupRequired() {
  const { t } = useTranslation("auth");
  return (
    <AuthCard title={t("twoFactor.requiredTitle")} description={t("twoFactor.requiredDescription")}>
      <TwoFactorEnrollment />
    </AuthCard>
  );
}
