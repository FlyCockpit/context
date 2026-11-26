import { Button } from "@cockpit-context/ui/components/button";
import { toast } from "@cockpit-context/ui/components/sileo";
import { type Dispatch, type SetStateAction, useRef } from "react";
import { useTranslation } from "react-i18next";

import { AuthCard } from "@/components/auth/auth-screen";
import { ONE_TIME_CODE_LENGTH, OneTimeCodeField } from "@/components/auth/plain-field";
import { authClient } from "@/lib/auth-client";
import { friendly, isCodeRejection, isRateLimit } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

/**
 * The whole 2FA challenge as one state object (rather than separate
 * `useState` calls) so a step change — entering the challenge, sending an
 * email code, a rejected code, or cancelling — is a single update and a single
 * render, with no way for the pieces to drift apart mid-transition. The login
 * page owns it above `AuthConfigGate`, so a gate flicker back to its skeleton
 * cannot discard a challenge in progress.
 *
 * `otpSent` marks the email-OTP path: once the user requests a code by email
 * we verify against verifyOtp instead of verifyTotp. `error` is the inline
 * message under the code field (a rejected code), cleared by the next edit.
 */
export const initialTwoFactorState = {
  active: false,
  code: "",
  verifying: false,
  otpSent: false,
  sendingOtp: false,
  error: null as string | null,
};

export type TwoFactorState = typeof initialTwoFactorState;

/** Password accepted, second factor needed: a fresh challenge. */
export function startTwoFactorChallenge(): TwoFactorState {
  return { ...initialTwoFactorState, active: true };
}

/**
 * Cancel: back to the sign-in form with nothing carried over — no code, no
 * error, no email-code mode — so the next sign-in (maybe another account)
 * starts clean.
 */
export function cancelTwoFactorChallenge(): TwoFactorState {
  return { ...initialTwoFactorState };
}

/** A rejected code: say so under the field and keep the code so it can be corrected. */
export function rejectTwoFactorCode(state: TwoFactorState, message: string): TwoFactorState {
  return { ...state, verifying: false, error: message };
}

/** Typing replaces the code and drops the previous rejection. */
export function editTwoFactorCode(state: TwoFactorState, code: string): TwoFactorState {
  return { ...state, code, error: null };
}

export function TwoFactorChallenge({
  twoFactor,
  setTwoFactor,
  emailEnabled,
  postAuthRedirect,
}: {
  twoFactor: TwoFactorState;
  setTwoFactor: Dispatch<SetStateAction<TwoFactorState>>;
  emailEnabled: boolean;
  postAuthRedirect: string;
}) {
  const { t } = useTranslation(["auth", "common"]);
  const codeInput = useRef<HTMLInputElement>(null);

  const reject = (message: string) => {
    setTwoFactor((s) => rejectTwoFactorCode(s, message));
    // Back to the field (the Verify button had focus), with the code selected
    // so typing replaces it.
    codeInput.current?.focus();
    codeInput.current?.select();
  };

  const handle2FAVerify = async () => {
    // Enter and the button both land here; one verification at a time.
    if (twoFactor.verifying) return;
    setTwoFactor((s) => ({ ...s, verifying: true, error: null }));
    try {
      // When the user requested an emailed code we verify against the OTP
      // endpoint; otherwise the code is a TOTP from their authenticator app.
      const result = twoFactor.otpSent
        ? await authClient.twoFactor.verifyOtp({ code: twoFactor.code })
        : await authClient.twoFactor.verifyTotp({ code: twoFactor.code });
      if (result.error) {
        console.error("[login.twoFactor.verify]", result.error);
        if (isCodeRejection(result.error)) reject(t("auth:errors.invalidTotp"));
        else {
          // Not the code's fault (rate limit, lockout, server, network): keep
          // the code as typed so the same one can be sent again.
          setTwoFactor((s) => ({ ...s, verifying: false }));
          toast.error(friendly(result.error));
        }
        return;
      }
      toast.success(t("auth:signedInSuccess"));
      window.location.assign(postAuthRedirect);
    } catch (err) {
      console.error("[login.twoFactor.verify]", err);
      setTwoFactor((s) => ({ ...s, verifying: false }));
      toast.error(friendly(err));
    }
  };

  const handleSendEmailOtp = async () => {
    setTwoFactor((s) => ({ ...s, sendingOtp: true }));
    try {
      // Delivery-aware preflight: Better-Auth's send-otp endpoint reports
      // success even when SMTP delivery fails, so verify the transport is
      // actually reachable before telling the user a code is on the way.
      const preflight = await orpc.auth.verifyEmailTransport.call().catch((err) => {
        console.error("[login.twoFactor.verifyEmailTransport]", err);
        return { ok: false };
      });
      if (!preflight.ok) {
        toast.error(t("auth:twoFactor.couldNotSendCode"));
        return;
      }
      const result = await authClient.twoFactor.sendOtp();
      if (result.error) {
        console.error("[login.twoFactor.sendOtp]", result.error);
        toast.error(
          isRateLimit(result.error) ? friendly(result.error) : t("auth:twoFactor.couldNotSendCode"),
        );
        return;
      }
      setTwoFactor((s) => ({ ...s, otpSent: true, code: "", error: null }));
      toast.success(t("auth:twoFactor.codeSent"));
    } catch (err) {
      // The request itself failed (server unreachable, offline).
      console.error("[login.twoFactor.sendOtp]", err);
      toast.error(friendly(err, t("auth:twoFactor.couldNotSendCode")));
    } finally {
      setTwoFactor((s) => ({ ...s, sendingOtp: false }));
    }
  };

  return (
    <AuthCard
      title={t("auth:twoFactor.title")}
      description={
        twoFactor.otpSent
          ? t("auth:twoFactor.emailCodeDescription")
          : t("auth:twoFactor.description")
      }
    >
      <OneTimeCodeField
        id="totp-code"
        label={t("auth:fields.verificationCode")}
        value={twoFactor.code}
        error={twoFactor.error}
        inputRef={codeInput}
        onValueChange={(code) => setTwoFactor((s) => editTwoFactorCode(s, code))}
        onComplete={handle2FAVerify}
      />
      <Button
        className="min-h-[44px] w-full"
        onClick={handle2FAVerify}
        disabled={twoFactor.code.length !== ONE_TIME_CODE_LENGTH || twoFactor.verifying}
      >
        {twoFactor.verifying ? t("auth:twoFactor.verifying") : t("auth:twoFactor.verify")}
      </Button>
      {emailEnabled && (
        <Button
          variant="outline"
          className="min-h-[44px] w-full"
          onClick={handleSendEmailOtp}
          disabled={twoFactor.sendingOtp}
        >
          {twoFactor.sendingOtp
            ? t("auth:twoFactor.sendingCode")
            : twoFactor.otpSent
              ? t("auth:twoFactor.resendEmailCode")
              : t("auth:twoFactor.emailMeCode")}
        </Button>
      )}
      <Button
        variant="ghost"
        className="min-h-[44px] w-full"
        disabled={twoFactor.verifying}
        onClick={() => setTwoFactor(cancelTwoFactorChallenge())}
      >
        {t("auth:twoFactor.cancel")}
      </Button>
    </AuthCard>
  );
}
