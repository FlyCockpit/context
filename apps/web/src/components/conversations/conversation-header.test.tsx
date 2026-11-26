import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  applyWatchEvent,
  type ConversationDetail,
  type ConversationViewState,
} from "@/lib/conversations";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  useNavigate: () => () => undefined,
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ isPending: false, mutate: () => undefined }),
  useQueryClient: () => ({}),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: { conversations: { delete: { mutationOptions: () => ({}) }, key: () => [] } },
}));

const { ConversationHeader } = await import("@/components/conversations/conversation-header");

const NOW = new Date("2026-11-26T00:00:00Z");
const SHA = "0ccd60aaba2811726335611347af932caf9a5000";

function state(overrides: Partial<ConversationDetail>): ConversationViewState {
  const conversation: ConversationDetail = {
    id: "c-1",
    createdAt: NOW,
    title: "How do I use useSuspenseQuery?",
    packageId: "pkg-1",
    packageIdentifier: "npm:@tanstack/react-query",
    requestedVersion: "5.59.0",
    requestedRef: null,
    commitSha: SHA,
    sourceUrl: "https://github.com/TanStack/query",
    resolvedFrom: "tag:v5.59.0",
    checkoutAvailable: true,
    origin: "web",
    mcpConnectionLabel: null,
    lastActivityAt: NOW,
    ongoing: false,
    totalCostUsdMicros: 0,
    totalUnpricedCalls: 0,
    latestRun: null,
    runs: [],
    truncated: false,
    ...overrides,
  };
  const folded = applyWatchEvent(null, { type: "snapshot", conversation, live: { runs: [] } });
  if (!folded) throw new Error("no state");
  return folded;
}

function render(overrides: Partial<ConversationDetail>) {
  return renderToStaticMarkup(
    <ConversationHeader state={state(overrides)} lang="en-US" reconnecting={false} />,
  );
}

describe("ConversationHeader commit link", () => {
  it("links the commit of a public GitHub source, with a 44px tap area on phones", () => {
    const html = render({});
    expect(html).toContain(`href="https://github.com/TanStack/query/commit/${SHA}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    // In flow (no overlay that could cover the package link when the row wraps).
    expect(html).toMatch(/class="inline-flex min-h-11 items-center[^"]*md:min-h-0"/);
    expect(html).not.toMatch(/before:-inset/);
  });

  it("shows the commit as text without a linkable source", () => {
    for (const sourceUrl of [null, "git@github.com:me/private.git"]) {
      const html = render({ sourceUrl });
      expect(html).toContain("0ccd60a");
      expect(html).not.toContain("/commit/");
    }
  });
});
