import enDashboard from "@cockpit-context/locales/src/en-US/dashboard.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationListItem } from "@/lib/conversations";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));

type PinsQuery = {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  data?: { items: ConversationListItem[]; limit: number };
  refetch: () => void;
};
const pins = vi.hoisted(() => ({
  query: null as unknown as PinsQuery,
  desired: null as string[] | null,
}));
vi.mock("@/hooks/use-pins", () => ({
  usePins: () => pins.query,
  usePinReorder: () => ({ save: vi.fn(), desired: pins.desired }),
  usePinToggle: () => ({ toggle: vi.fn(), isPending: false }),
  usePinState: (id: string) => ({
    ready: true,
    pinned: pins.query.data?.items.some((item) => item.id === id) ?? false,
    full: false,
    limit: 12,
  }),
}));

const { PinnedSection } = await import("./pinned-section");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { dashboard: enDashboard, common: {} } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

const NOW = new Date("2026-11-26T12:00:00Z");

function item(id: string, title: string): ConversationListItem {
  return {
    id,
    title,
    packageId: "p1",
    packageIdentifier: "npm:react",
    requestedVersion: "19.0.0",
    requestedRef: null,
    commitSha: null,
    resolvedFrom: null,
    origin: "web",
    mcpConnectionLabel: null,
    lastActivityAt: NOW,
    ongoing: false,
    latestRun: null,
    totalCostUsdMicros: 0,
    totalUnpricedCalls: 0,
  } as unknown as ConversationListItem;
}

function loaded(items: ConversationListItem[]): PinsQuery {
  return {
    isPending: false,
    isError: false,
    isSuccess: true,
    data: { items, limit: 12 },
    refetch: vi.fn(),
  };
}

function render() {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PinnedSection lang="en-US" now={NOW.getTime()} />
    </I18nextProvider>,
  );
}

describe("PinnedSection", () => {
  beforeEach(() => {
    pins.query = loaded([]);
    pins.desired = null;
  });

  it("renders nothing without pins, and nothing while the first read is in flight", () => {
    expect(render()).toBe("");
    pins.query = { isPending: true, isError: false, isSuccess: false, refetch: vi.fn() };
    expect(render()).toBe("");
  });

  it("lists the pins in their saved order under a Pinned heading", () => {
    pins.query = loaded([item("c2", "Second question"), item("c1", "First question")]);
    const html = render();
    expect(html).toContain('id="home-pinned-title"');
    expect(html).toContain(">Pinned</h2>");
    expect(html.indexOf("Second question")).toBeLessThan(html.indexOf("First question"));
  });

  it("gives every row a labelled drag handle that also takes the arrow keys", () => {
    pins.query = loaded([item("c1", "First question"), item("c2", "Second question")]);
    const html = render();
    const handles = [...html.matchAll(/<button[^>]*aria-label="Reorder “([^”]*)”"[^>]*>/g)];
    expect(handles.map((match) => match[1])).toEqual(["First question", "Second question"]);
    for (const [handle] of handles) {
      // Touch drags neither scroll the page nor pull to refresh.
      expect(handle).toContain('data-pull-to-refresh="off"');
      expect(handle).toContain("touch-none");
      // The hint says how to reorder without a pointer.
      expect(handle).toMatch(/aria-describedby="[^"]+"/);
    }
    expect(html).toContain("Drag to reorder, or press the up and down arrow keys.");
    // A row menu per pin, named after its conversation.
    expect(html).toContain('aria-label="Actions for “First question”"');
    expect(html).toContain('aria-label="Actions for “Second question”"');
  });

  it("offers no drag handle for a single pin", () => {
    pins.query = loaded([item("c1", "Only question")]);
    const html = render();
    expect(html).toContain("Only question");
    expect(html).not.toContain("Reorder “");
  });

  it("keeps its heading and offers a retry when the pins fail to load", () => {
    pins.query = { isPending: false, isError: true, isSuccess: false, refetch: vi.fn() };
    const html = render();
    expect(html).toContain(">Pinned</h2>");
    expect(html).toContain("Couldn’t load your pinned conversations.");
  });

  it("keeps the loaded pins with a retry banner when a refetch fails", () => {
    pins.query = { ...loaded([item("c1", "First question")]), isError: true };
    const html = render();
    expect(html).toContain("First question");
    expect(html).toContain("Couldn’t load your pinned conversations.");
  });

  it("shows an order still being saved over an older cached one", () => {
    pins.query = loaded([item("c1", "First question"), item("c2", "Second question")]);
    pins.desired = ["c2", "c1"];
    const html = render();
    expect(html.indexOf("Second question")).toBeLessThan(html.indexOf("First question"));
  });

  it("falls back to the cached order when the pins changed under a pending save", () => {
    pins.query = loaded([item("c1", "First question"), item("c3", "Third question")]);
    pins.desired = ["c2", "c1"];
    const html = render();
    expect(html.indexOf("First question")).toBeLessThan(html.indexOf("Third question"));
  });
});
