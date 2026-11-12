import enAdmin from "@cockpit-context/locales/src/en-US/admin.json";
import esAdmin from "@cockpit-context/locales/src/es-MX/admin.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, Trans } from "react-i18next";
import { describe, expect, it } from "vitest";

// Keep the bootstrap setting's markup aligned in both shipped languages.
// Explicit components avoid duplicated prose from JSX child indexing.
describe("<Trans> components-prop rendering", () => {
  it.each(["en-US", "es-MX"])("wraps ADMIN_EMAILS once in %s", async (lang) => {
    const i18n = createInstance();
    await i18n.init({
      lng: lang,
      fallbackLng: "en-US",
      ns: ["admin"],
      defaultNS: "admin",
      resources: { "en-US": { admin: enAdmin }, "es-MX": { admin: esAdmin } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <Trans
          i18nKey="setupBanner.message"
          ns="admin"
          components={[<code key="0" className="font-mono" />]}
        />
      </I18nextProvider>,
    );
    expect(html).toContain('<code class="font-mono">ADMIN_EMAILS</code>');
    expect(html.match(/ADMIN_EMAILS/g)).toHaveLength(1);
    expect(html).not.toContain("<0>");
    expect(html).toContain(
      lang === "en-US"
        ? "then sign up with that address."
        : "Después crea una cuenta con esa dirección.",
    );
  });
});
