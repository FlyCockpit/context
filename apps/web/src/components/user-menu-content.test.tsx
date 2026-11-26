import enNav from "@cockpit-context/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The signed-in account menu's shape (the one confirmed in ws-model-proxy):
 * who is signed in as a three-line label (nothing pressable), the userMenu
 * destinations, then Sign out last after a separator, aligned like the other
 * items. The Base UI primitives are replaced by plain elements so the
 * structure renders statically and each item's click handler can be called.
 */
const fixture = vi.hoisted(() => ({
  role: "user",
  items: [] as { text: string; onClick?: () => unknown }[],
  signOut: vi.fn(),
  undo: vi.fn(),
  leave: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@cockpit-context/ui/components/dropdown-menu", () => {
  const passthrough =
    (tag: string) =>
    ({ children, className }: { children?: ReactNode; className?: string }) => (
      <div data-slot={tag} className={className}>
        {children}
      </div>
    );
  return {
    DropdownMenu: passthrough("menu"),
    DropdownMenuContent: passthrough("content"),
    DropdownMenuGroup: passthrough("group"),
    DropdownMenuLabel: passthrough("label"),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: ({
      children,
      "aria-label": label,
    }: {
      children: ReactNode;
      "aria-label"?: string;
    }) => (
      <button type="button" aria-label={label}>
        {children}
      </button>
    ),
    DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => unknown }) => {
      fixture.items.push({ text: "", onClick });
      return <div data-slot="item">{children}</div>;
    },
  };
});
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ lang: "en-US" }),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: {
      status: "authenticated",
      session: {
        user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com", role: fixture.role },
        session: { id: "s1" },
      },
    },
  }),
}));
vi.mock("@/lib/document-identity", () => ({
  markExplicitSignOut: () => fixture.undo,
  leaveDocument: fixture.leave,
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: fixture.signOut } }));
vi.mock("@cockpit-context/ui/components/sileo", () => ({ toast: { error: fixture.toastError } }));
vi.mock("@/utils/friendly-error", () => ({
  friendly: (_error: unknown, fallback: string) => fallback,
}));

const { default: UserMenuContent } = await import("./user-menu-content");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { nav: enNav } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.role = "user";
  fixture.items = [];
  fixture.signOut.mockReset();
  fixture.undo.mockReset();
  fixture.leave.mockReset();
  fixture.toastError.mockReset();
});

const render = () =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UserMenuContent />
    </I18nextProvider>,
  );

describe("account menu", () => {
  it("labels who is signed in in three lines, with no pressable email", () => {
    const html = render();
    const label = html.match(/<div data-slot="label"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const lines = [...label.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => m[2]);
    expect(lines).toEqual([enNav.userMenu.myAccount, "Ada Lovelace", "ada@example.com"]);
    expect(label).toContain('title="ada@example.com"');
    // The email is only in the label, never an item.
    const items = [...html.matchAll(/<div data-slot="item">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    expect(items.some((item) => item?.includes("ada@example.com"))).toBe(false);
  });

  it("lists Settings (and Admin for admins), then Sign out last after a separator", () => {
    fixture.role = "admin";
    const html = render();
    const items = [...html.matchAll(/<div data-slot="item">([\s\S]*?)<\/div>/g)].map((m) =>
      (m[1] ?? "").replace(/<[^>]*>/g, ""),
    );
    expect(items).toEqual([enNav.items.settings, enNav.items.admin, enNav.userMenu.signOut]);
    // Its own group after a separator, with an icon like the items above it
    // (so its text lines up with theirs), and nothing after it.
    expect(html).toMatch(
      /<hr\/><div data-slot="item"><svg[\s\S]*?<\/svg>Sign out<\/div><\/div><\/div><\/div>$/,
    );
  });

  it("names the trigger and shows the name only from md:", () => {
    const html = render();
    // The visible name starts the accessible name (WCAG 2.5.3).
    expect(html).toContain('aria-label="Ada Lovelace, account menu"');
    expect(html).toContain('class="hidden truncate md:block">Ada Lovelace<');
  });

  it("undoes the sign-out mark and says so when sign-out fails", async () => {
    fixture.signOut.mockResolvedValue({ error: { status: 500 } });
    render();
    await fixture.items.at(-1)?.onClick?.();
    expect(fixture.undo).toHaveBeenCalledTimes(1);
    expect(fixture.toastError).toHaveBeenCalledWith(enNav.userMenu.signOutFailed);
  });

  it("does the same when the request throws", async () => {
    fixture.signOut.mockRejectedValue(new Error("offline"));
    render();
    await fixture.items.at(-1)?.onClick?.();
    expect(fixture.undo).toHaveBeenCalledTimes(1);
    expect(fixture.toastError).toHaveBeenCalledTimes(1);
  });

  it("keeps the mark when sign-out succeeds, and leaves for the sign-in page", async () => {
    fixture.signOut.mockImplementation(
      async (options: { fetchOptions: { onSuccess: () => void } }) => {
        options.fetchOptions.onSuccess();
        return { data: { success: true }, error: null };
      },
    );
    render();
    await fixture.items.at(-1)?.onClick?.();
    expect(fixture.undo).not.toHaveBeenCalled();
    expect(fixture.toastError).not.toHaveBeenCalled();
    // A quarantined full load (lib/document-identity.ts), not a client navigate.
    expect(fixture.leave).toHaveBeenCalledWith("/en-US/login");
  });
});
