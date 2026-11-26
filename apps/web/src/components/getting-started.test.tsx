import enCommon from "@cockpit-context/locales/src/en-US/common.json";
import enDashboard from "@cockpit-context/locales/src/en-US/dashboard.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Ongoing's getting-started checklist: done states come from `home.status`,
 * it is gone once all three are done or the user hid it, and it is a
 * disclosure collapsed below `sm` (title, progress and Hide stay visible).
 * Rendered statically with a fake `window` (matchMedia, localStorage).
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a data-to={to}>{children}</a>,
}));
vi.mock("@cockpit-context/ui/components/sileo", () => ({
  toast: { message: vi.fn(), success: vi.fn() },
}));
vi.mock("@cockpit-context/ui/components/copy-field", () => ({
  CopyField: ({ value }: { value: string }) => <code data-copy={value} />,
}));
vi.mock("@cockpit-context/ui/components/code-snippet", () => ({
  CodeSnippet: ({ code }: { code: string }) => <code data-snippet={code} />,
}));

const { GettingStarted } = await import("./getting-started");
type Status = Parameters<typeof GettingStarted>[0]["status"];

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { common: enCommon, dashboard: enDashboard } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
afterEach(() => vi.unstubAllGlobals());

const base = {
  hasConnection: true,
  hasPackages: false,
  hasConversations: false,
  modelConfigured: true,
  mcpUrl: "https://context.example/mcp",
} as unknown as Status;

/** Render with a fake browser: `wide` is whether `(min-width: 40rem)` matches. */
function render(status: Partial<Status> = {}, { wide = true, hidden = false } = {}) {
  const storage = new Map<string, string>(
    hidden ? [["cockpit-context.getting-started.hidden.u1", "1"]] : [],
  );
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: wide }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <GettingStarted lang="en-US" status={{ ...base, ...status }} scope="u1" />
    </I18nextProvider>,
  );
}

describe("GettingStarted (Ongoing)", () => {
  it("shows the progress from the server's done states", () => {
    expect(render()).toContain(">1 of 3 done<");
  });

  it("marks done steps and shows the next action only for open ones", () => {
    const html = render();
    expect(html).toMatch(/data-step="connect" data-done=""/);
    expect(html).toMatch(/data-step="package" class=/);
    // The connected step no longer offers its commands.
    expect(html).not.toContain("data-snippet=");
    expect(html).not.toContain('data-copy="claude');
    // The open steps keep theirs: Packages, and the example question.
    expect(html).toContain('data-to="/$lang/packages"');
    expect(html).toContain(`data-copy="${enDashboard.ongoing.start.ask.example}"`);
  });

  it("stays until the first conversation, then renders nothing", () => {
    expect(render({ hasPackages: true })).toContain(">2 of 3 done<");
    expect(render({ hasPackages: true, hasConversations: true })).toBe("");
  });

  it("renders nothing for a user who hid it", () => {
    expect(render({}, { hidden: true })).toBe("");
  });

  it("is a disclosure, expanded from sm up", () => {
    const html = render({}, { wide: true });
    const button = html.match(
      /<button type="button" aria-expanded="([^"]*)" aria-controls="([^"]*)"/,
    );
    expect(button?.[1]).toBe("true");
    expect(html).toContain(`id="${button?.[2]}"`);
    expect(html).not.toMatch(/<div [^>]*hidden=""/);
  });

  it("is collapsed below sm, keeping the title, progress and Hide visible", () => {
    const html = render({}, { wide: false });
    const button = html.match(
      /<button type="button" aria-expanded="([^"]*)" aria-controls="([^"]*)"/,
    );
    expect(button?.[1]).toBe("false");
    expect(html).toMatch(new RegExp(`id="${button?.[2]}" hidden=""`));
    expect(html).toContain(`>${enDashboard.ongoing.start.title}<`);
    expect(html).toContain(">1 of 3 done<");
    expect(html).toMatch(/aria-label="Hide the getting-started checklist"[^>]*>Hide</);
  });
});
