import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  forms: [] as {
    onSubmit: (context: { value: Record<string, string> }) => Promise<void>;
    validators?: { onSubmit?: unknown };
  }[],
  enable: vi.fn(),
  verify: vi.fn(),
  reset: vi.fn(),
  reload: vi.fn(),
  error: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (harness.state[index] === undefined) harness.state[index] = initial;
    return [
      harness.state[index],
      (value: unknown) => {
        harness.state[index] = value;
      },
    ];
  },
}));
vi.mock("@tanstack/react-form", () => ({
  useForm: (options: (typeof harness.forms)[number]) => {
    harness.forms.push(options);
    return { reset: harness.reset };
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@cockpit-context/ui/components/sileo", () => ({ toast: { error: harness.error } }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { twoFactor: { enable: harness.enable, verifyTotp: harness.verify } },
}));
vi.mock("@/components/auth/auth-screen", () => ({ AuthCard: () => null }));
vi.mock("@/components/two-factor-setup-details", () => ({ TwoFactorSetupDetails: () => null }));

import { TwoFactorEnrollment } from "./two-factor-enrollment";

// Exercise the shared form submissions without a browser or real auth IO.
function renderEnrollment() {
  harness.cursor = 0;
  harness.forms = [];
  TwoFactorEnrollment();
  return { password: harness.forms[0], code: harness.forms[1] };
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.state = [];
  vi.stubGlobal("window", { location: { reload: harness.reload } });
});
afterEach(() => vi.unstubAllGlobals());

describe("TwoFactorEnrollment", () => {
  it("accepts an empty password so SSO-only accounts can enroll passwordlessly", () => {
    const schema = renderEnrollment().password?.validators?.onSubmit as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ password: "" }).success).toBe(true);
  });

  it("keeps the enrollment closed when enabling fails", async () => {
    harness.enable.mockResolvedValueOnce({ error: { code: "INVALID_PASSWORD" } });
    await renderEnrollment().password?.onSubmit({ value: { password: "wrong" } });
    expect(harness.state[0]).toBe("intro");
    expect(harness.state[1]).toBeNull();
    expect(harness.error).toHaveBeenCalledWith("auth:twoFactor.couldNotStartSetup");
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("requires TOTP setup data before advancing to the backup-code checkpoint", async () => {
    harness.enable.mockResolvedValueOnce({ data: { method: "email" } });
    await renderEnrollment().password?.onSubmit({ value: { password: "password" } });
    expect(harness.state[0]).toBe("intro");
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("shows backup codes and clears the password after enabling TOTP", async () => {
    harness.enable.mockResolvedValueOnce({
      data: { method: "totp", totpURI: "otpauth://totp/test", backupCodes: ["recovery"] },
    });
    await renderEnrollment().password?.onSubmit({ value: { password: "password" } });
    expect(harness.enable).toHaveBeenCalledWith({ password: "password", method: "totp" });
    expect(harness.state[0]).toBe("backup");
    expect(harness.state[1]).toEqual({ totpURI: "otpauth://totp/test", backupCodes: ["recovery"] });
    expect(harness.reset).toHaveBeenCalledOnce();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("keeps failed verification retryable without reloading", async () => {
    harness.verify.mockResolvedValueOnce({ error: { code: "INVALID_TOTP" } });
    await renderEnrollment().code?.onSubmit({ value: { code: "123456" } });
    expect(harness.error).toHaveBeenCalledWith("auth:errors.invalidTotp");
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("reloads all session-derived gates only after successful verification", async () => {
    harness.verify.mockResolvedValueOnce({ data: { status: true } });
    await renderEnrollment().code?.onSubmit({ value: { code: "123456" } });
    expect(harness.verify).toHaveBeenCalledWith({ code: "123456" });
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(harness.error).not.toHaveBeenCalled();
  });
});
