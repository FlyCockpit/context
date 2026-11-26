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
  setFieldMeta: vi.fn(),
  focus: vi.fn(),
  select: vi.fn(),
  config: { ssoEnabled: false } as { ssoEnabled: boolean } | undefined,
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
  useRef: () => ({ current: { focus: harness.focus, select: harness.select } }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: harness.config }) }));
vi.mock("@/utils/friendly-error", () => ({
  // A context fallback would show instead of the mapped copy, so a passed one
  // (e.g. "invalid code") is visible in the assertions.
  friendly: (_error: unknown, fallback?: string) => fallback ?? "friendly copy",
  isRateLimit: (e: { status?: number }) => e.status === 429,
  isCodeRejection: (e: { code?: string }) =>
    ["INVALID_CODE", "INVALID_BACKUP_CODE", "OTP_HAS_EXPIRED"].includes(e.code ?? ""),
}));
vi.mock("@/utils/orpc", () => ({ orpc: { appConfig: { queryOptions: () => ({}) } } }));
vi.mock("@tanstack/react-form", () => ({
  useForm: (options: (typeof harness.forms)[number]) => {
    harness.forms.push(options);
    return { reset: harness.reset, setFieldMeta: harness.setFieldMeta };
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
  const tree = TwoFactorEnrollment();
  return { password: harness.forms[0], code: harness.forms[1], tree };
}

type Node = { props?: { children?: unknown; onClick?: () => void } };

/** Every host element and string in a rendered tree, without rendering components. */
function walk(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  out.push(node);
  const children = (node as Node | null)?.props?.children;
  if (typeof children === "function") return out;
  if (children !== undefined) walk(children, out);
  return out;
}

const texts = (tree: unknown) => walk(tree).filter((n): n is string => typeof n === "string");

/** The server's answer as the field's onSubmit error (lib/form-server-error). */
function serverFieldError(field: string): unknown {
  const call = harness.setFieldMeta.mock.calls.find(([name]) => name === field);
  return call ? call[1]({ errorMap: {} }).errorMap.onSubmit : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.state = [];
  harness.config = { ssoEnabled: false };
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

  it("says a wrong password under the field and keeps the enrollment closed", async () => {
    harness.enable.mockResolvedValueOnce({ error: { code: "INVALID_PASSWORD" } });
    await renderEnrollment().password?.onSubmit({ value: { password: "wrong" } });
    expect(harness.state[0]).toBe("intro");
    expect(harness.state[1]).toBeNull();
    expect(serverFieldError("password")).toBe("auth:errors.invalidPassword");
    expect(harness.focus).toHaveBeenCalled();
    expect(harness.error).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("keeps other enable failures as a toast", async () => {
    harness.enable.mockResolvedValueOnce({ error: { code: "INTERNAL", status: 500 } });
    await renderEnrollment().password?.onSubmit({ value: { password: "pw" } });
    expect(harness.error).toHaveBeenCalledWith("auth:twoFactor.couldNotStartSetup");
    expect(harness.setFieldMeta).not.toHaveBeenCalled();
  });

  it("mentions passwordless enrollment only when SSO sign-in exists", () => {
    harness.state = ["password", null];
    expect(texts(renderEnrollment().tree)).not.toContain("auth:twoFactor.passwordlessPrompt");
    harness.config = { ssoEnabled: true };
    expect(texts(renderEnrollment().tree)).toContain("auth:twoFactor.passwordlessPrompt");
  });

  it.each(["backup", "verify"])(
    "offers Cancel on the %s step, which forgets the secret",
    (step) => {
      harness.state = [step, { totpURI: "otpauth://totp/test", backupCodes: ["recovery"] }];
      // On the verify step Cancel sits inside the form's Subscribe render prop.
      const nodes = walk(renderEnrollment().tree);
      for (const node of nodes) {
        const render = (node as Node | null)?.props?.children;
        if (typeof render === "function") {
          walk(render({ canSubmit: true, isSubmitting: false, code: "", name: "code" }), nodes);
        }
      }
      const button = nodes.find(
        (n) => (n as Node | null)?.props?.children === "common:actions.cancel",
      ) as Node;
      button.props?.onClick?.();
      expect(harness.state[0]).toBe("intro");
      expect(harness.state[1]).toBeNull();
      expect(harness.reset).toHaveBeenCalledTimes(2);
    },
  );

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

  it("says a wrong code under the field and keeps it retryable without reloading", async () => {
    harness.verify.mockResolvedValueOnce({ error: { status: 401, code: "INVALID_CODE" } });
    await renderEnrollment().code?.onSubmit({ value: { code: "123456" } });
    expect(serverFieldError("code")).toBe("auth:errors.invalidTotp");
    expect(harness.select).toHaveBeenCalled();
    expect(harness.error).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it.each([
    ["a rate limit", { status: 429, code: "TOO_MANY_REQUESTS" }],
    ["a server failure", { status: 503 }],
    ["an expired 2FA session", { status: 401, code: "INVALID_TWO_FACTOR_COOKIE" }],
  ])("shows %s as a toast and keeps the code sendable", async (_name, error) => {
    harness.verify.mockResolvedValueOnce({ error });
    await renderEnrollment().code?.onSubmit({ value: { code: "123456" } });
    expect(harness.setFieldMeta).not.toHaveBeenCalled();
    expect(harness.error).toHaveBeenCalledExactlyOnceWith("friendly copy");
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("shows a thrown network failure as a toast, not as a wrong code", async () => {
    harness.verify.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await renderEnrollment().code?.onSubmit({ value: { code: "123456" } });
    expect(harness.setFieldMeta).not.toHaveBeenCalled();
    expect(harness.error).toHaveBeenCalledExactlyOnceWith("friendly copy");
  });

  it("reloads all session-derived gates only after successful verification", async () => {
    harness.verify.mockResolvedValueOnce({ data: { status: true } });
    await renderEnrollment().code?.onSubmit({ value: { code: "123456" } });
    expect(harness.verify).toHaveBeenCalledWith({ code: "123456" });
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(harness.error).not.toHaveBeenCalled();
  });
});
