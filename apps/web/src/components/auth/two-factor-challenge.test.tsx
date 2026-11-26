import enAuth from "@cockpit-context/locales/src/en-US/auth.json";
import enCommon from "@cockpit-context/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import type { ReactNode, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TwoFactorState } from "./two-factor-challenge";

const harness = vi.hoisted(() => ({
  verifyTotp: vi.fn(),
  sendOtp: vi.fn(),
  verifyEmailTransport: vi.fn(),
  toastError: vi.fn(),
  buttons: [] as { children: unknown; onClick?: () => unknown }[],
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { twoFactor: { verifyTotp: harness.verifyTotp, sendOtp: harness.sendOtp } },
}));
vi.mock("@/utils/orpc", () => ({
  orpc: { auth: { verifyEmailTransport: { call: harness.verifyEmailTransport } } },
}));
vi.mock("@cockpit-context/ui/components/sileo", () => ({
  toast: { error: harness.toastError, success: vi.fn() },
}));
// A plain <button> that remembers its click handler, so a test can press Verify.
vi.mock("@cockpit-context/ui/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => unknown;
    disabled?: boolean;
  }) => {
    harness.buttons.push({ children, onClick });
    return (
      <button type="button" disabled={disabled}>
        {children}
      </button>
    );
  },
}));

const {
  cancelTwoFactorChallenge,
  editTwoFactorCode,
  initialTwoFactorState,
  rejectTwoFactorCode,
  startTwoFactorChallenge,
  TwoFactorChallenge,
} = await import("./two-factor-challenge");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { auth: enAuth, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

describe("2FA challenge state", () => {
  it("Cancel resets the whole challenge: code, error and email-code mode", () => {
    const midway = rejectTwoFactorCode(
      { ...startTwoFactorChallenge(), code: "123456", otpSent: true },
      enAuth.errors.invalidTotp,
    );
    expect(midway.active).toBe(true);
    expect(cancelTwoFactorChallenge()).toEqual(initialTwoFactorState);
    expect(cancelTwoFactorChallenge()).not.toBe(initialTwoFactorState);
  });

  it("a rejected code keeps the code to correct, and editing drops the error", () => {
    const rejected = rejectTwoFactorCode(
      { ...startTwoFactorChallenge(), code: "123456", verifying: true },
      enAuth.errors.invalidTotp,
    );
    expect(rejected).toMatchObject({ code: "123456", verifying: false });
    expect(rejected.error).toBe(enAuth.errors.invalidTotp);
    expect(editTwoFactorCode(rejected, "12345")).toMatchObject({ code: "12345", error: null });
  });
});

describe("TwoFactorChallenge", () => {
  function render(error: string | null) {
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <TwoFactorChallenge
          twoFactor={{ ...startTwoFactorChallenge(), code: "123456", error }}
          setTwoFactor={vi.fn()}
          emailEnabled={false}
          postAuthRedirect="/en-US/dashboard"
        />
      </I18nextProvider>,
    );
  }

  it("offers a clear Cancel", () => {
    expect(render(null)).toContain(`>${enAuth.twoFactor.cancel}</button>`);
    expect(enAuth.twoFactor.cancel).toBe("Cancel");
  });

  it("shows a wrong code under the field, not only in a toast", () => {
    const html = render(enAuth.errors.invalidTotp);
    const input = html.match(/<input[^>]*id="totp-code"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="totp-code-error"');
    expect(html).toContain('<div id="totp-code-error" role="alert">');
  });
});

describe("TwoFactorChallenge verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.buttons = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /** Press Verify with a typed code and return the state the challenge ends in. */
  async function verify() {
    let state: TwoFactorState = { ...startTwoFactorChallenge(), code: "123456" };
    const setTwoFactor = (next: SetStateAction<TwoFactorState>) => {
      state = typeof next === "function" ? next(state) : next;
    };
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <TwoFactorChallenge
          twoFactor={state}
          setTwoFactor={setTwoFactor}
          emailEnabled={false}
          postAuthRedirect="/en-US/dashboard"
        />
      </I18nextProvider>,
    );
    const button = harness.buttons.find((b) => b.children === enAuth.twoFactor.verify);
    await button?.onClick?.();
    return state;
  }

  it("puts a wrong code under the field and keeps it to correct", async () => {
    harness.verifyTotp.mockResolvedValueOnce({ error: { status: 401, code: "INVALID_CODE" } });
    const state = await verify();
    expect(state).toMatchObject({ code: "123456", verifying: false });
    expect(state.error).toBe(enAuth.errors.invalidTotp);
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["a rate limit", { status: 429, code: "TOO_MANY_REQUESTS" }],
    ["a lockout", { status: 403, code: "ACCOUNT_TEMPORARILY_LOCKED" }],
    ["a server failure", { status: 503 }],
  ])("shows %s as a toast, not as a wrong code", async (_name, error) => {
    harness.verifyTotp.mockResolvedValueOnce({ error });
    const state = await verify();
    expect(state).toMatchObject({ code: "123456", verifying: false, error: null });
    expect(harness.toastError).toHaveBeenCalledOnce();
    expect(harness.toastError.mock.calls[0]?.[0]).not.toBe(enAuth.errors.invalidTotp);
  });

  it("shows a thrown network failure as a toast and keeps the code for resending", async () => {
    harness.verifyTotp.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const state = await verify();
    expect(state).toMatchObject({ code: "123456", verifying: false, error: null });
    expect(harness.toastError).toHaveBeenCalledOnce();
    expect(harness.toastError.mock.calls[0]?.[0]).not.toBe(enAuth.errors.invalidTotp);
  });
});

describe("TwoFactorChallenge email me a code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.buttons = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("shows a rejected send request (server unreachable) as a toast and settles", async () => {
    harness.verifyEmailTransport.mockResolvedValueOnce({ ok: true });
    harness.sendOtp.mockRejectedValueOnce(new Error("boom"));
    let state: TwoFactorState = startTwoFactorChallenge();
    const setTwoFactor = (next: SetStateAction<TwoFactorState>) => {
      state = typeof next === "function" ? next(state) : next;
    };
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <TwoFactorChallenge
          twoFactor={state}
          setTwoFactor={setTwoFactor}
          emailEnabled
          postAuthRedirect="/en-US/dashboard"
        />
      </I18nextProvider>,
    );
    const button = harness.buttons.find((b) => b.children === enAuth.twoFactor.emailMeCode);
    await expect(button?.onClick?.()).resolves.toBeUndefined();
    expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(enAuth.twoFactor.couldNotSendCode);
    expect(state).toMatchObject({ sendingOtp: false, otpSent: false });
  });
});
