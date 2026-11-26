import enDashboard from "@cockpit-context/locales/src/en-US/dashboard.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  value: { ready: true, pinned: false, full: false, limit: 12 },
}));
vi.mock("@/hooks/use-pins", () => ({
  usePinState: () => state.value,
  usePinToggle: () => ({ toggle: vi.fn(), isPending: false }),
}));

const { ConversationPinButton } = await import("./conversation-pin");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { dashboard: enDashboard } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

function button(value: typeof state.value) {
  state.value = value;
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ConversationPinButton id="c1" />
    </I18nextProvider>,
  );
  const tag = /<button[^>]*>/.exec(html)?.[0] ?? "";
  return { tag, disabled: /\sdisabled(=""|\s|>)/.test(tag) };
}

describe("ConversationPinButton", () => {
  it("offers to pin an unpinned conversation", () => {
    const { tag, disabled } = button({ ready: true, pinned: false, full: false, limit: 12 });
    expect(tag).toContain('aria-label="Pin to home"');
    expect(tag).toContain('aria-pressed="false"');
    expect(disabled).toBe(false);
  });

  it("offers to unpin a pinned one, even when Pinned is full", () => {
    const { tag, disabled } = button({ ready: true, pinned: true, full: false, limit: 12 });
    expect(tag).toContain('aria-label="Unpin from home"');
    expect(tag).toContain('aria-pressed="true"');
    expect(disabled).toBe(false);
  });

  it("says why it cannot pin when Pinned is full", () => {
    const { tag, disabled } = button({ ready: true, pinned: false, full: true, limit: 12 });
    expect(tag).toContain('aria-label="Pinned is full (12). Unpin one first."');
    expect(disabled).toBe(true);
  });

  it("waits for the pins before offering either", () => {
    const { tag, disabled } = button({ ready: false, pinned: false, full: false, limit: 0 });
    expect(tag).not.toContain("aria-pressed=");
    expect(disabled).toBe(true);
  });
});
