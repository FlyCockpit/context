import enAuth from "@cockpit-context/locales/src/en-US/auth.json";
import enCommon from "@cockpit-context/locales/src/en-US/common.json";
import enPrivacy from "@cockpit-context/locales/src/en-US/privacy.json";
import { createInstance } from "i18next";
import { type ComponentType, lazy, type ReactNode } from "react";
import { prerender } from "react-dom/static";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sign-up-mode states of sign-in and `/signup`, and the password rule shown
 * up front. Route files cannot hold tests (the route generator would treat
 * them as routes), so the routes are rendered from here. docs/ui.md § Sign-up
 * modes.
 */
const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  toastError: vi.fn(),
  setServerFieldError: vi.fn(),
  // The options of the last form a page created, so a test can submit it.
  form: null as null | {
    onSubmit: (context: { value: Record<string, string> }) => Promise<void>;
  },
}));

vi.mock("@tanstack/react-form", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-form")>();
  return {
    ...actual,
    useForm: (options: Parameters<typeof actual.useForm>[0]) => {
      fixture.form = options as unknown as typeof fixture.form;
      return actual.useForm(options);
    },
  };
});
// A prerender mounts no field meta, so record server field errors instead.
vi.mock("@/lib/form-server-error", () => ({
  setServerFieldError: (_form: unknown, field: string, message: string) =>
    fixture.setServerFieldError(field, message),
  clearServerFieldError: vi.fn(),
}));
vi.mock("@cockpit-context/ui/components/sileo", () => ({
  toast: { error: fixture.toastError, success: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
    useSearch: () => ({}),
  }),
  // Route components are code-split, so renders wait for the split chunk.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") =>
    lazy(async () => ({ default: (await importer())[name] as ComponentType })),
  redirect: (options: unknown) => ({ redirect: options }),
  useNavigate: () => vi.fn(),
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a data-to={to} className={className ?? ""}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: fixture.config, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/utils/orpc", () => ({ orpc: { appConfig: { queryOptions: () => ({}) } } }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: "anonymous" } }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { email: fixture.signInEmail }, signUp: { email: fixture.signUpEmail } },
}));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: vi.fn(async () => ({ status: "ok", session: null })),
}));

const { Route: LoginRoute } = await import("@/routes/$lang/_app/login");
const { Route: SignupRoute } = await import("@/routes/$lang/_app/signup");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { auth: enAuth, common: enCommon, privacy: enPrivacy } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.config = undefined;
  fixture.form = null;
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const base = { forceSso: false, ssoEnabled: false, emailConfigured: true, adminSetup: null };
const OPEN = { ...base, signupOpen: true, adminBootstrapSignupEnabled: false };
const CLOSED = { ...base, signupOpen: false, adminBootstrapSignupEnabled: false };
const FORCE_SSO = { ...OPEN, forceSso: true, ssoEnabled: true, ssoProviderName: "Okta" };

type Route = { options: { component: ComponentType } };

async function render(route: unknown): Promise<string> {
  const { component: Component } = (route as Route).options;
  const { prelude } = await prerender(
    <I18nextProvider i18n={i18n}>
      <Component />
    </I18nextProvider>,
  );
  return new Response(prelude).text();
}

const signupLinks = (html: string) =>
  [...html.matchAll(/<a data-to="\/\$lang\/signup" class="[^"]*">(.*?)<\/a>/g)].map(
    ([, inner = ""]) => inner.replace(/<[^>]*>/g, ""),
  );

describe("sign-in page", async () => {
  it("is titled Sign in, not Welcome back (true on a first sign-in too)", async () => {
    fixture.config = OPEN;
    expect(await render(LoginRoute)).toContain(`>${enAuth.login.signinTitle}<`);
    expect(enAuth.login.signinTitle).toBe("Sign in");
  });

  it("open: links to sign-up", async () => {
    fixture.config = OPEN;
    expect(signupLinks(await render(LoginRoute))).toEqual([enAuth.login.signupHint]);
  });

  it("closed: no sign-up link, and the invite-only note instead", async () => {
    fixture.config = CLOSED;
    const html = await render(LoginRoute);
    expect(signupLinks(html)).toEqual([]);
    expect(html).toContain(enAuth.signupMode.inviteOnly);
  });

  it("SSO-only: neither a sign-up link nor the invite-only note", async () => {
    fixture.config = FORCE_SSO;
    const html = await render(LoginRoute);
    expect(signupLinks(html)).toEqual([]);
    expect(html).not.toContain(enAuth.signupMode.inviteOnly);
  });
});

describe("/signup", async () => {
  it("shows the password rule before any submit, wired to the field", async () => {
    fixture.config = OPEN;
    const html = await render(SignupRoute);
    const rule = enAuth.fields.passwordRule.replace("{{min}}", "12");
    const description = new RegExp(`<div id="([^"]+)"[^>]*>${rule}</div>`).exec(html);
    expect(description, html).not.toBeNull();
    expect(html).toMatch(
      new RegExp(
        `type="password"[^>]*aria-describedby="${description?.[1]}"|aria-describedby="${description?.[1]}"[^>]*type="password"`,
      ),
    );
  });

  it("closed: explains itself instead of a form", async () => {
    fixture.config = CLOSED;
    const html = await render(SignupRoute);
    expect(html).toContain(enAuth.signup.closedTitle);
    expect(html).not.toContain('type="password"');
  });
});

/** Render a page, then submit its form with `value` as TanStack Form would. */
async function submit(route: unknown, value: Record<string, string>) {
  await render(route);
  expect(fixture.form).not.toBeNull();
  await fixture.form?.onSubmit({ value });
}
const fieldError = (name: string) =>
  fixture.setServerFieldError.mock.calls.findLast(([field]) => field === name)?.[1];

describe("sign-in submit", () => {
  it("a thrown request (server unreachable) is a toast; the same credentials can be resent", async () => {
    fixture.config = OPEN;
    fixture.signInEmail.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await submit(LoginRoute, { email: "a@b.co", password: "password1" });
    expect(fixture.toastError).toHaveBeenCalledOnce();
    expect(fieldError("password")).toBeUndefined();
  });
});

describe("/signup submit", () => {
  const value = { name: "Ada", email: "a@b.co", password: "a-long-password", bootstrapToken: "" };

  it("a thrown request (server unreachable) is a toast, not an unhandled rejection", async () => {
    fixture.config = OPEN;
    fixture.signUpEmail.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await submit(SignupRoute, value);
    expect(fixture.toastError).toHaveBeenCalledOnce();
    expect(fieldError("email")).toBeUndefined();
  });

  it("an address already registered (422 without SMTP) goes under the email field", async () => {
    fixture.config = OPEN;
    fixture.signUpEmail.mockResolvedValueOnce({
      data: null,
      error: { status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
    });
    await submit(SignupRoute, value);
    expect(fieldError("email")).toBe(enAuth.errors.accountAlreadyRegistered);
    expect(fixture.toastError).not.toHaveBeenCalled();
  });

  it("sign-up closed (the same 422 for every address) stays a toast", async () => {
    fixture.config = OPEN;
    fixture.signUpEmail.mockResolvedValueOnce({
      data: null,
      error: { status: 422, code: "FAILED_TO_CREATE_USER" },
    });
    await submit(SignupRoute, value);
    expect(fieldError("email")).toBeUndefined();
    expect(fixture.toastError).toHaveBeenCalled();
  });
});
