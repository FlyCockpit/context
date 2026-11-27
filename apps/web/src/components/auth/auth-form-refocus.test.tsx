import enAuth from "@cockpit-context/locales/src/en-US/auth.json";
import enCommon from "@cockpit-context/locales/src/en-US/common.json";
import enNav from "@cockpit-context/locales/src/en-US/nav.json";
import esAuth from "@cockpit-context/locales/src/es-MX/auth.json";
import esCommon from "@cockpit-context/locales/src/es-MX/common.json";
import { createInstance } from "i18next";
import { act, type ComponentType, lazy, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { prerender } from "react-dom/static";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A signed-out visitor's typed email and password survive the tab regaining
 * focus. Better Auth 1.7 refetches the session on focus and marks every
 * request of an empty session `isPending` again (`dist/client/query.mjs`,
 * `onRequest`: `isPending: currentValue.data === null`), the same snapshot as
 * the first load. These tests drive the real `useAuthSession` through that
 * snapshot sequence with the real sign-in and sign-up pages:
 * - mounted with the real React DOM client (into the small in-memory DOM
 *   below, as the repo has no DOM library), a typed email and password stay
 *   in the same TanStack form instance and the same input nodes across the
 *   refetch and a failed refetch, so React kept the form mounted;
 * - server-rendered, each snapshot gives byte-identical markup, and only the
 *   first load shows the skeleton. Same for the header's account control.
 * Route components are code-split (the router plugin runs under vitest too),
 * so the pages are lazy: renders wait for the split chunk.
 */
type Snapshot = {
  data: { user: { id: string; name: string } } | null;
  isPending: boolean;
  isRefetching: boolean;
  error: unknown | null;
};

const fixture = vi.hoisted(() => ({
  lang: "en-US",
  resetPassword: vi.fn(),
  navigate: vi.fn(),
  snapshot: {
    data: null,
    isPending: true,
    isRefetching: false,
    error: null,
  } as Snapshot,
  config: {
    forceSso: false,
    ssoEnabled: false,
    emailConfigured: true,
    adminSetup: null,
    signupOpen: true,
    adminBootstrapSignupEnabled: false,
  },
}));

/** Every TanStack form instance the pages created: a remount makes a new one. */
const formApis = vi.hoisted(() => new Set<unknown>());
vi.mock("@tanstack/react-form", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-form")>();
  const useForm: typeof actual.useForm = (options) => {
    const form = actual.useForm(options);
    formApis.add(form);
    return form;
  };
  return { ...actual, useForm };
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: fixture.lang }),
    useSearch: () => ({ token: "reset-token" }),
  }),
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") =>
    lazy(async () => ({ default: (await importer())[name] as ComponentType })),
  redirect: (options: unknown) => ({ redirect: options }),
  useNavigate: () => fixture.navigate,
  useParams: () => ({ lang: fixture.lang }),
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a data-to={to} className={className ?? ""}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: fixture.config, isPending: false, isError: false, refetch: vi.fn() }),
  useMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: { queryOptions: () => ({}), queryKey: () => ["appConfig"], call: async () => ({}) },
  },
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ ...fixture.snapshot, refetch: vi.fn() }),
    resetPassword: fixture.resetPassword,
  },
}));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => true }));
vi.mock("@cockpit-context/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: vi.fn(async () => ({ status: "resolved", session: null })),
  getSessionCookieHint: vi.fn(async () => false),
}));

const { resetAuthSessionMemoryForTests } = await import("@/hooks/use-auth-session");
const { Route: LoginRoute } = await import("@/routes/$lang/_app/login");
const { Route: ResetRoute } = await import("@/routes/$lang/_app/reset-password");
const { Route: SignupRoute } = await import("@/routes/$lang/_app/signup");
const { default: UserMenu } = await import("@/components/user-menu");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: {
      "en-US": { auth: enAuth, common: enCommon, nav: enNav },
      "es-MX": { auth: esAuth, common: esCommon },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  // Load the split route chunks once, before any test stubs `window`: their
  // imports read the real (absent) one at module load.
  for (const Page of [
    page(LoginRoute).component,
    page(SignupRoute).component,
    page(ResetRoute).component,
  ]) {
    await render(Page, FIRST_LOAD);
  }
});
beforeEach(() => {
  // The hook only remembers browser snapshots (the server's never settle).
  vi.stubGlobal("window", {});
  resetAuthSessionMemoryForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const FIRST_LOAD: Snapshot = { data: null, isPending: true, isRefetching: true, error: null };
const ANONYMOUS: Snapshot = { data: null, isPending: false, isRefetching: false, error: null };
const REFETCH: Snapshot = { data: null, isPending: true, isRefetching: true, error: null };
const FAILED_REFETCH: Snapshot = {
  data: null,
  isPending: false,
  isRefetching: false,
  error: { status: 503 },
};

async function render(Component: () => ReactNode, snapshot: Snapshot): Promise<string> {
  fixture.snapshot = snapshot;
  const { prelude } = await prerender(
    <I18nextProvider i18n={i18n}>
      <Component />
    </I18nextProvider>,
  );
  return new Response(prelude).text();
}

const page = (route: unknown) => (route as { options: { component: () => ReactNode } }).options;

describe.each([
  ["sign-in", page(LoginRoute).component],
  ["sign-up", page(SignupRoute).component],
])("%s page across a refocus refetch", (_name, Page) => {
  it("shows the skeleton only while the first load is pending", async () => {
    const html = await render(Page, FIRST_LOAD);
    expect(html).not.toContain('type="email"');
    expect(html).toContain('data-slot="skeleton"');
  });

  it("server-renders byte-identical markup while Better Auth refetches", async () => {
    const settled = await render(Page, ANONYMOUS);
    expect(settled).toContain('type="email"');
    expect(settled).toContain('type="password"');

    expect(await render(Page, REFETCH)).toBe(settled);
    expect(await render(Page, FAILED_REFETCH)).toBe(settled);
    expect(await render(Page, ANONYMOUS)).toBe(settled);
  });
});

describe("header account control across a refocus refetch", () => {
  it("is a skeleton only on the first load", async () => {
    const first = await render(UserMenu, FIRST_LOAD);
    expect(first).toContain('data-slot="skeleton"');

    const settled = await render(UserMenu, ANONYMOUS);
    expect(settled).toContain('data-to="/$lang/login"');
    expect(await render(UserMenu, REFETCH)).toBe(settled);
  });

  it("a sign-in in another tab still replaces the anonymous state", async () => {
    await render(UserMenu, ANONYMOUS);
    const signedIn = await render(UserMenu, {
      data: { user: { id: "u1", name: "Ada" } },
      isPending: false,
      isRefetching: false,
      error: null,
    });
    expect(signedIn).toContain("Ada");
    expect(signedIn).not.toContain('data-to="/$lang/login"');
  });
});

// A minimal in-memory DOM: just what React DOM's client needs to create,
// update and move nodes. Enough to prove node identity across renders; it
// does no layout, events or selectors.
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  constructor(
    readonly ownerDocument: FakeDocument | null,
    readonly nodeType: number,
    readonly nodeName: string,
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) - 1] ?? null) : null;
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(text: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(new FakeText(this.ownerDocument, text));
  }
  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }
  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    child.parentNode?.removeChild(child);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  getRootNode(): FakeNode {
    let node: FakeNode = this;
    while (node.parentNode) node = node.parentNode;
    return node;
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeText extends FakeNode {
  constructor(
    doc: FakeDocument | null,
    public nodeValue: string,
    nodeType = 3,
  ) {
    super(doc, nodeType, nodeType === 3 ? "#text" : "#comment");
  }
  get data() {
    return this.nodeValue;
  }
  override get textContent() {
    return this.nodeValue;
  }
  override set textContent(text: string) {
    this.nodeValue = text;
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly style = { setProperty() {}, removeProperty() {} };
  /** React DOM writes `value`, `type`, `checked` as properties. */
  [property: string]: unknown;
  constructor(
    doc: FakeDocument,
    readonly localName: string,
    readonly namespaceURI: string,
  ) {
    super(doc, 1, localName.toUpperCase());
  }
  get tagName() {
    return this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_namespace: string, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_namespace: string, name: string) {
    this.removeAttribute(name);
  }
  focus() {}
  blur() {}
}

class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly activeElement = null;
  defaultView: unknown = null;
  constructor() {
    super(null, 9, "#document");
    this.documentElement = this.appendChild(this.createElement("html"));
    this.head = this.documentElement.appendChild(this.createElement("head"));
    this.body = this.documentElement.appendChild(this.createElement("body"));
  }
  createElement(tag: string) {
    return new FakeElement(this, tag.toLowerCase(), "http://www.w3.org/1999/xhtml");
  }
  createElementNS(namespace: string, tag: string) {
    return new FakeElement(this, tag, namespace);
  }
  createTextNode(text: string) {
    return new FakeText(this, text);
  }
  createComment(text: string) {
    return new FakeText(this, text, 8);
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

function findInput(node: FakeNode, type: string): FakeElement | undefined {
  if (node instanceof FakeElement && node.localName === "input" && node.type === type) return node;
  for (const child of node.childNodes) {
    const found = findInput(child, type);
    if (found) return found;
  }
  return undefined;
}

type FormApi = { setFieldValue: (name: string, value: string) => void };

describe.each([
  ["sign-in", page(LoginRoute).component],
  ["sign-up", page(SignupRoute).component],
])("%s page mounted in React DOM across a refocus refetch", (_name, Page) => {
  let container: FakeElement;
  let root: Root;

  beforeEach(() => {
    const doc = new FakeDocument();
    const classes = {
      Node: FakeNode,
      Element: FakeElement,
      HTMLElement: FakeElement,
      HTMLIFrameElement: class {},
    };
    const win = { ...classes, document: doc, addEventListener() {}, removeEventListener() {} };
    doc.defaultView = win;
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    for (const [name, value] of Object.entries(classes)) vi.stubGlobal(name, value);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = doc.body.appendChild(doc.createElement("div"));
    root = createRoot(container as unknown as Element);
    formApis.clear();
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  async function show(snapshot: Snapshot) {
    fixture.snapshot = snapshot;
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <Page />
        </I18nextProvider>,
      );
    });
  }

  /** Types into the mounted form, as the visitor would before leaving the tab. */
  async function type(email: string, password: string) {
    const [form] = [...formApis] as FormApi[];
    await act(async () => {
      form?.setFieldValue("email", email);
      form?.setFieldValue("password", password);
    });
  }

  it("keeps the form instance, its input nodes and the typed values", async () => {
    await show(FIRST_LOAD);
    expect(findInput(container, "email")).toBeUndefined();

    await show(ANONYMOUS);
    expect(formApis.size).toBe(1);
    await type("ada@example.com", "correct horse");
    const email = findInput(container, "email");
    const password = findInput(container, "password");
    expect(email?.value).toBe("ada@example.com");
    expect(password?.value).toBe("correct horse");

    for (const snapshot of [REFETCH, FAILED_REFETCH, ANONYMOUS]) {
      await show(snapshot);
      expect(findInput(container, "email")).toBe(email);
      expect(findInput(container, "password")).toBe(password);
      expect(email?.value).toBe("ada@example.com");
      expect(password?.value).toBe("correct horse");
    }
    expect(formApis.size).toBe(1);
  });

  it("detects a remount: a forgotten anonymity drops the form and its values", async () => {
    await show(ANONYMOUS);
    await type("ada@example.com", "correct horse");
    const email = findInput(container, "email");

    // What every refetch did before the fix: the first-load snapshot again.
    resetAuthSessionMemoryForTests();
    await show(REFETCH);
    expect(findInput(container, "email")).toBeUndefined();

    await show(ANONYMOUS);
    const remounted = findInput(container, "email");
    expect(remounted).toBeDefined();
    expect(remounted).not.toBe(email);
    expect(remounted?.value).toBe("");
    expect(formApis.size).toBe(2);
  });
});

describe.each(["en-US", "es-MX"])("reset password recovery in %s", (lang) => {
  let container: FakeElement;
  let root: Root;
  beforeEach(async () => {
    const doc = new FakeDocument();
    const classes = {
      Node: FakeNode,
      Element: FakeElement,
      HTMLElement: FakeElement,
      HTMLIFrameElement: class {},
    };
    const win = { ...classes, document: doc, addEventListener() {}, removeEventListener() {} };
    doc.defaultView = win;
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    for (const [name, value] of Object.entries(classes)) vi.stubGlobal(name, value);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = doc.body.appendChild(doc.createElement("div"));
    root = createRoot(container as unknown as Element);
    formApis.clear();
    fixture.lang = lang;
    fixture.resetPassword.mockReset();
    fixture.navigate.mockReset();
    await i18n.changeLanguage(lang);
    const Page = page(ResetRoute).component;
    await act(async () =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Page />
        </I18nextProvider>,
      ),
    );
  });
  afterEach(async () => {
    act(() => root.unmount());
    fixture.lang = "en-US";
    await i18n.changeLanguage("en-US");
  });

  async function submit() {
    const [form] = [...formApis] as (FormApi & {
      handleSubmit: () => Promise<void>;
      getFieldValue: (name: string) => string;
    })[];
    if (!form) throw new Error("Missing reset form");
    await act(async () => {
      form.setFieldValue("newPassword", "replacement-password-456");
      form.setFieldValue("confirmPassword", "replacement-password-456");
    });
    await act(async () => form.handleSubmit());
    return form;
  }

  it("keeps the typed password after 503 and retries the same token", async () => {
    fixture.resetPassword.mockResolvedValueOnce({
      error: { status: 503, message: "preflight failed" },
    });
    const input = findInput(container, "password");
    const form = await submit();
    expect(Boolean(findInput(container, "password"))).toBe(true);
    expect(findInput(container, "password")).toBe(input);
    expect(input?.value).toBe("replacement-password-456");
    expect(form.getFieldValue("confirmPassword")).toBe("replacement-password-456");
    const messages = lang === "es-MX" ? esAuth : enAuth;
    expect(container.textContent).toContain(messages.resetPassword.retryable);
    expect(container.textContent).toContain(i18n.t("common:actions.retry"));
    expect(container.textContent).not.toContain(messages.resetPassword.invalidTitle);
    expect(fixture.navigate).not.toHaveBeenCalled();
    fixture.resetPassword.mockResolvedValueOnce({ error: null });
    await act(async () => form.handleSubmit());
    expect(fixture.resetPassword).toHaveBeenCalledTimes(2);
    expect(fixture.resetPassword).toHaveBeenLastCalledWith({
      token: "reset-token",
      newPassword: "replacement-password-456",
    });
    expect(fixture.navigate).toHaveBeenCalledOnce();
    expect(formApis.size).toBe(1);
  });

  it.each([400, 500])("keeps the form for a non-token error with status %s", async (status) => {
    fixture.resetPassword.mockResolvedValueOnce({ error: { status, code: "OTHER_ERROR" } });
    await submit();
    expect(Boolean(findInput(container, "password"))).toBe(true);
    expect(container.textContent).toContain(
      (lang === "es-MX" ? esAuth : enAuth).resetPassword.failed,
    );
    expect(container.textContent).not.toContain(
      (lang === "es-MX" ? esAuth : enAuth).resetPassword.invalidTitle,
    );
  });

  it("shows an invalid link for the pinned invalid/expired token code", async () => {
    fixture.resetPassword.mockResolvedValueOnce({ error: { status: 400, code: "INVALID_TOKEN" } });
    await submit();
    expect(findInput(container, "password")).toBeUndefined();
    expect(container.textContent).toContain(
      (lang === "es-MX" ? esAuth : enAuth).resetPassword.invalidTitle,
    );
    expect(container.textContent).toContain(
      (lang === "es-MX" ? esAuth : enAuth).resetPassword.requestNewLink,
    );
  });
});
