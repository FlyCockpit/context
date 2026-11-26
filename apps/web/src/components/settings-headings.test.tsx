import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type ComponentType, lazy, type ReactNode } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";

/**
 * Every settings page has one h1: the settings layout's "Settings" title. The
 * pages under it (profile, security, and any added later) title their sections
 * with card titles holding an h2, never a second h1, a `PageHeader` (which
 * renders one) or a `role="heading"` stand-in. Route files cannot hold tests,
 * so the layout is rendered from here and the pages are read as source.
 */
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  // Route components are code-split, so renders wait for the split chunk.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") =>
    lazy(async () => ({ default: (await importer())[name] as ComponentType })),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => <section data-outlet="" />,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { Route: SettingsRoute } = await import("@/routes/$lang/_app/_auth/settings");

const SETTINGS_DIR = path.resolve(import.meta.dirname, "../routes/$lang/_app/_auth/settings");

describe("settings headings", () => {
  it("the layout renders exactly one h1, above the page", async () => {
    const { component: Layout } = (
      SettingsRoute as unknown as { options: { component: () => ReactNode } }
    ).options;
    const { prelude } = await prerender(<Layout />);
    const html = await new Response(prelude).text();
    expect(html).not.toContain('role="heading"');
    expect(html.match(/<h1\b[^>]*>([^<]*)<\/h1>/g)).toEqual([
      expect.stringContaining(">title</h1>"),
    ]);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("data-outlet"));
  });

  const pages = readdirSync(SETTINGS_DIR).filter((file) => file.endsWith(".tsx"));

  it.each(pages)("%s adds no level-1 heading of its own", (file) => {
    const source = readFileSync(path.join(SETTINGS_DIR, file), "utf8");
    expect(source).not.toMatch(/<h1\b/);
    expect(source).not.toMatch(/<PageHeader\b/);
    expect(source).not.toMatch(/role="heading"/);
    expect(source).not.toMatch(/aria-level/);
  });

  it.each(pages)("%s titles each card with a real h2", (file) => {
    const source = readFileSync(path.join(SETTINGS_DIR, file), "utf8");
    const titles = [...source.matchAll(/<CardTitle\b[^>]*>\s*([\s\S]*?)<\/CardTitle>/g)];
    expect(titles.length).toBeGreaterThan(0);
    for (const [, inner = ""] of titles) expect(inner).toMatch(/^<h2\b/);
  });

  it("finds the settings pages", () => {
    expect(pages).toEqual(expect.arrayContaining(["index.tsx", "security.tsx"]));
  });
});
