import enDashboard from "@cockpit-context/locales/src/en-US/dashboard.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ConversationListItem } from "@/lib/conversations";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));

const { ConversationRow } = await import("./conversation-row");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { dashboard: enDashboard } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

const NOW = new Date("2026-11-26T12:00:00Z");
const TITLE = "How does the retry middleware decide when to back off on a 429 from the registry?";

const item = {
  id: "c1",
  title: TITLE,
  packageId: "p1",
  packageIdentifier: "npm:@scope/some-long-package-name",
  requestedVersion: "10.4.12-beta.3",
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

describe("ConversationRow", () => {
  it("wraps the title to two lines and never cuts the package version short", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ConversationRow item={item} lang="en-US" now={NOW.getTime()} />
      </I18nextProvider>,
    );
    const title = /<span data-slot="conversation-title" class="([^"]*)">([^<]*)<\/span>/.exec(html);
    expect(title?.[2]).toBe(TITLE);
    expect(title?.[1]).toContain("line-clamp-2");
    expect(title?.[1]).not.toContain("truncate");
    const version =
      /<span class="([^"]*font-mono[^"]*)">npm:@scope\/some-long-package-name@10\.4\.12-beta\.3<\/span>/.exec(
        html,
      );
    expect(version?.[1]).not.toContain("truncate");
  });
});
