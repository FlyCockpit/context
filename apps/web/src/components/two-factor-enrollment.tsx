import { Button } from "@cockpit-context/ui/components/button";
import { toast } from "@cockpit-context/ui/components/sileo";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthCard } from "@/components/auth/auth-screen";
import { TwoFactorSetupDetails } from "@/components/two-factor-setup-details";
import { authClient } from "@/lib/auth-client";

/** One enrollment flow for settings and the forced-enrollment takeover. */
export function TwoFactorEnrollment() {
  const { t } = useTranslation(["auth", "settings", "common"]);
  const [step, setStep] = useState<"intro" | "password" | "backup" | "verify">("intro");
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
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
        if (result.error || result.data?.method !== "totp") {
          toast.error(t("auth:twoFactor.couldNotStartSetup"));
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
          toast.error(t("auth:errors.invalidTotp"));
          return;
        }
        // Refresh the document and all session-derived gates after enrollment.
        window.location.reload();
      } catch {
        toast.error(t("auth:errors.invalidTotp"));
      }
    },
  });

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
        <p className="text-sm text-muted-foreground">{t("auth:twoFactor.passwordlessPrompt")}</p>
        <passwordForm.Field name="password">
          {(field) => (
            <TextField
              field={field}
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
                onClick={() => {
                  passwordForm.reset();
                  setStep("intro");
                }}
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
        <Button size="touch" onClick={() => setStep("verify")}>
          {t("settings:security.savedBackupCodes")}
        </Button>
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
              <Button
                size="touch"
                type="submit"
                disabled={!canSubmit || !/^\d{6}$/.test(code) || isSubmitting}
              >
                {isSubmitting ? t("auth:twoFactor.verifying") : t("auth:twoFactor.verifyAndEnable")}
              </Button>
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
