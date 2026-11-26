import enDashboard from "@cockpit-context/locales/src/en-US/dashboard.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { FlagSwitches } from "./flag-switches";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { dashboard: enDashboard } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

describe("FlagSwitches", () => {
  it("names each row switch with its flag and the row's name, so rows differ for a screen reader", () => {
    const value = { allowPropose: true, autoApprove: false };
    const html = render(
      <>
        <FlagSwitches variant="row" subject="Work laptop" value={value} onChange={vi.fn()} />
        <FlagSwitches variant="row" subject="CI runner" value={value} onChange={vi.fn()} />
      </>,
    );
    const names = [...html.matchAll(/role="switch"[^>]*aria-label="([^"]+)"/g)].map(
      ([, name]) => name,
    );
    expect(names).toEqual([
      "May propose packages: Work laptop",
      "Auto-approve proposals: Work laptop",
      "May propose packages: CI runner",
      "Auto-approve proposals: CI runner",
    ]);
    // The visible label stays the short flag text (the accessible name starts with it).
    expect(html).toContain(">May propose packages</label>");
  });
});
