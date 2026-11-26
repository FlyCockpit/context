import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  forms: [] as { onSubmit: (context: { value: Record<string, string> }) => Promise<void> }[],
  signIn: vi.fn(),
  verifyTotp: vi.fn(),
  toastError: vi.fn(),
  setFieldMeta: vi.fn(),
  assign: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (harness.state[index] === undefined) harness.state[index] = initial;
    return [
      harness.state[index],
      (next: unknown) => {
        harness.state[index] =
          typeof next === "function"
            ? (next as (s: unknown) => unknown)(harness.state[index])
            : next;
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// The real classifiers and friendly(), with copy as its keys.
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key, exists: () => false } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ isError: false, isPending: false, data: undefined }),
}));
vi.mock("@tanstack/react-form", () => ({
  useForm: (options: (typeof harness.forms)[number]) => {
    harness.forms.push(options);
    return { handleSubmit: vi.fn(), setFieldMeta: harness.setFieldMeta };
  },
}));
vi.mock("@cockpit-context/ui/components/sileo", () => ({ toast: { error: harness.toastError } }));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: harness.signIn },
    twoFactor: { verifyTotp: harness.verifyTotp },
    oauth2: { publicClientPrelogin: vi.fn() },
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: "anonymous" } }),
}));
vi.mock("@/components/auth/auth-screen", () => ({ AuthCard: () => null, AuthScreen: () => null }));
vi.mock("@/lib/mcp-oauth-search", () => ({
  parseMcpOAuthSearch: () => ({ usable: true, clientId: "c1" }),
  mcpPageHref: () => "/en-US/mcp-consent",
  resolveOauthRedirectUrl: () => null,
  toMcpPublicClientInfo: (data: unknown) => data,
}));

vi.mock("@/components/mcp/client-tile", () => ({ ClientTile: () => null }));

const { McpLoginPage } = await import("./mcp-login-page");
const { OneTimeCodeField } = await import("@/components/auth/plain-field");

type Element = { type?: unknown; props?: { children?: unknown; onClick?: () => void } };

/** Every element in a tree, without rendering components. */
function walk(node: unknown, out: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  out.push(node as Element);
  const children = (node as Element).props?.children;
  if (children !== undefined && typeof children !== "function") walk(children, out);
  return out;
}

const SIGNED_QUERY = "client_id=c1&sig=s";

/** Render the anonymous sign-in step (McpSignIn) by calling the components directly. */
function renderSignIn() {
  harness.cursor = 0;
  harness.forms = [];
  const page = McpLoginPage({ lang: "en-US", rawSearch: SIGNED_QUERY }) as unknown as {
    type: (props: unknown) => unknown;
    props: unknown;
  };
  return page.type(page.props);
}

type TwoFactor = { active: boolean; code: string; busy: boolean; error: string | null };
const twoFactor = () => harness.state[0] as TwoFactor;

/** The button on the rendered step whose label is `label`. */
function button(tree: unknown, label: string) {
  return walk(tree).find(
    (el) => typeof el.props?.onClick === "function" && el.props?.children === label,
  );
}

/** Press Verify on the 2FA step with a typed code, and wait for it to settle. */
async function verify() {
  harness.state = [{ active: true, code: "123456", busy: false, error: null }];
  button(renderSignIn(), "auth:twoFactor.verify")?.props?.onClick?.();
  expect(twoFactor().busy).toBe(true);
  await vi.waitFor(() => expect(twoFactor().busy).toBe(false));
}

/** The password field's server error, as the last setFieldMeta call wrote it. */
function passwordServerError() {
  const call = harness.setFieldMeta.mock.calls.findLast(([name]) => name === "password");
  const updater = call?.[1] as ((prev: { errorMap: object }) => { errorMap: object }) | undefined;
  return (updater?.({ errorMap: {} }).errorMap as { onSubmit?: string } | undefined)?.onSubmit;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.state = [];
  vi.stubGlobal("window", { location: { assign: harness.assign } });
});
afterEach(() => vi.unstubAllGlobals());

describe("McpLoginPage sign-in", () => {
  it("puts a credential rejection under the password field, not in a toast", async () => {
    renderSignIn();
    harness.signIn.mockResolvedValueOnce({
      error: { status: 401, code: "INVALID_EMAIL_OR_PASSWORD" },
    });
    await harness.forms[0]?.onSubmit({ value: { email: "a@b.co", password: "pw" } });
    expect(passwordServerError()).toBe("auth:errors.invalidCredentials");
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it("shows a thrown failure (server unreachable) as a toast, with no field error", async () => {
    renderSignIn();
    harness.signIn.mockRejectedValueOnce(new Error("boom"));
    await harness.forms[0]?.onSubmit({ value: { email: "a@b.co", password: "pw" } });
    expect(harness.toastError).toHaveBeenCalledExactlyOnceWith("errors:generic");
    expect(harness.setFieldMeta).not.toHaveBeenCalled();
  });

  it.each([
    ["a server failure", { status: 503 }, "errors:serverError"],
    ["a session failure", { status: 401, code: "FAILED_TO_CREATE_SESSION" }, "errors:sessionEnded"],
  ])("shows %s as what happened, not as wrong credentials", async (_name, error, copy) => {
    renderSignIn();
    harness.signIn.mockResolvedValueOnce({ error });
    await harness.forms[0]?.onSubmit({ value: { email: "a@b.co", password: "pw" } });
    expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(copy);
    expect(harness.setFieldMeta).not.toHaveBeenCalled();
  });
});

describe("McpLoginPage 2FA verify", () => {
  it("puts a wrong code under the code field, not in a toast", async () => {
    harness.verifyTotp.mockResolvedValueOnce({ error: { status: 401, code: "INVALID_CODE" } });
    await verify();
    expect(harness.toastError).not.toHaveBeenCalled();
    expect(twoFactor()).toMatchObject({
      code: "123456",
      busy: false,
      error: "auth:errors.invalidTotp",
    });
    const field = walk(renderSignIn()).find((el) => el.type === OneTimeCodeField) as
      | { props: { id: string; error: string | null } }
      | undefined;
    expect(field?.props).toMatchObject({ id: "mcp-totp-code", error: "auth:errors.invalidTotp" });
  });

  it("shows a 503 as a server failure and keeps the code", async () => {
    harness.verifyTotp.mockResolvedValueOnce({ error: { status: 503 } });
    await verify();
    expect(harness.toastError).toHaveBeenCalledExactlyOnceWith("errors:serverError");
    expect(twoFactor()).toMatchObject({ code: "123456", busy: false, error: null });
  });

  it("shows a thrown failure without calling it an invalid code", async () => {
    harness.verifyTotp.mockRejectedValueOnce(new Error("boom"));
    await verify();
    expect(harness.toastError).toHaveBeenCalledExactlyOnceWith("errors:generic");
    expect(twoFactor()).toMatchObject({ code: "123456", busy: false, error: null });
  });
});

describe("McpLoginPage 2FA cancel", () => {
  it("goes back to the credential form and clears the challenge", () => {
    harness.state = [
      { active: true, code: "123456", busy: false, error: "auth:errors.invalidTotp" },
    ];
    button(renderSignIn(), "auth:twoFactor.cancel")?.props?.onClick?.();
    expect(twoFactor()).toEqual({ active: false, code: "", busy: false, error: null });
    // The credential form again: its Sign in button, no Verify.
    const tree = renderSignIn();
    expect(button(tree, "auth:twoFactor.verify")).toBeUndefined();
    expect(walk(tree).some((el) => el.type === "form")).toBe(true);
  });
});
