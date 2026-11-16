import enDashboard from "@cockpit-context/locales/src/en-US/dashboard.json";
import esDashboard from "@cockpit-context/locales/src/es-MX/dashboard.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import { ConversationCost } from "@/components/conversations/conversation-cost";

async function render(
  props: { costUsdMicros: number; unpricedCalls: number; compact?: boolean },
  lng = "en-US",
): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: "en-US",
    ns: ["dashboard"],
    defaultNS: "dashboard",
    resources: { "en-US": { dashboard: enDashboard }, "es-MX": { dashboard: esDashboard } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ConversationCost {...props} />
    </I18nextProvider>,
  );
}

// An unpriced model call makes the shown amount a lower bound or unknown: it must
// never read as a plain total.
describe("ConversationCost", () => {
  it("shows a fully priced cost as a plain amount", async () => {
    expect(await render({ costUsdMicros: 41_830, unpricedCalls: 0 })).toBe("$0.0418");
  });

  it("marks a partly priced cost as a lower bound", async () => {
    expect(await render({ costUsdMicros: 41_830, unpricedCalls: 2 })).toBe(
      "≥ $0.0418, some calls unpriced",
    );
  });

  it("shows a cost with nothing priced as unknown, never $0", async () => {
    const html = await render({ costUsdMicros: 0, unpricedCalls: 1 });
    expect(html).toBe("Unknown, calls unpriced");
    expect(html).not.toContain("$0");
  });

  it("keeps the full wording for screen readers and the tooltip in the compact form", async () => {
    const html = await render({ costUsdMicros: 41_830, unpricedCalls: 1, compact: true });
    expect(html).toContain('title="≥ $0.0418, some calls unpriced"');
    expect(html).toContain('<span aria-hidden="true">≥ $0.0418</span>');
    expect(html).toContain('<span class="sr-only">≥ $0.0418, some calls unpriced</span>');
  });

  it("is translated in es-MX", async () => {
    expect(await render({ costUsdMicros: 0, unpricedCalls: 1 }, "es-MX")).toBe(
      "Desconocido, llamadas sin precio",
    );
  });
});
