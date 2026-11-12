import enPrivacy from "@cockpit-context/locales/src/en-US/privacy.json";
import esPrivacy from "@cockpit-context/locales/src/es-MX/privacy.json";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";

import {
  conversationRetentionCopy,
  PRIVACY_SECTIONS,
  privacyNoticeKeys,
} from "@/lib/privacy-notice";

type Tree = { [key: string]: string | Tree };

function leafKeys(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`),
  );
}

function lookup(tree: Tree, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object") return (node as Tree)[part];
    return undefined;
  }, tree);
}

describe("privacy notice copy", () => {
  const bundles = { "en-US": enPrivacy as Tree, "es-MX": esPrivacy as Tree };

  it.each(Object.entries(bundles))(
    "%s has a non-empty string for every rendered key",
    (_, tree) => {
      for (const key of privacyNoticeKeys()) {
        const value = lookup(tree, key);
        expect(typeof value, key).toBe("string");
        expect((value as string).trim(), key).not.toBe("");
      }
    },
  );

  it("renders every key the bundles define, and both locales define the same keys", () => {
    const rendered = new Set(privacyNoticeKeys());
    expect(new Set(leafKeys(bundles["en-US"]))).toEqual(rendered);
    expect(new Set(leafKeys(bundles["es-MX"]))).toEqual(rendered);
  });

  it("renders the operator identity from deploy-time config, with neutral text when unset", () => {
    const contact = PRIVACY_SECTIONS.filter((section) => section.contact).map((s) => [
      s.id,
      s.contact,
    ]);
    expect(contact).toEqual([
      ["operator", "operator"],
      ["requests", "requests"],
    ]);
    expect(lookup(bundles["en-US"], "sections.operator.contact.unpublished")).toMatch(
      /has not published contact details/,
    );
    // No "Pending" placeholder is left anywhere in the notice.
    for (const tree of Object.values(bundles)) {
      for (const key of leafKeys(tree)) {
        expect(key).not.toMatch(/pending/i);
        expect(String(lookup(tree, key)), key).not.toMatch(/\bPending\b|Pendiente/);
      }
    }
  });

  it("states automatic conversation deletion and backup retention", () => {
    const retention = PRIVACY_SECTIONS.find((section) => section.id === "retention");
    expect(retention?.items).toContain("backups");
    expect(retention?.retentionItem).toBe("conversations");
    const conversations = lookup(
      bundles["en-US"],
      "sections.retention.items.conversations.detailAfterDays_other",
    );
    expect(conversations).toMatch(/Deleted automatically/);
    expect(conversations).toMatch(/cannot be recovered except from a database backup/);
    expect(lookup(bundles["en-US"], "sections.retention.items.backups.detail")).toMatch(
      /retention the operator configured on the backup storage/,
    );
  });

  it("lists only strictly necessary storage and says there is no tracking", () => {
    const cookies = PRIVACY_SECTIONS.find((section) => section.id === "cookies");
    // Each key the app actually sets (docs/product.md).
    expect(cookies?.items).toEqual([
      "session",
      "challenge",
      "theme",
      "locale",
      "interface",
      "offline",
      "recovery",
    ]);
    for (const tree of Object.values(bundles)) {
      for (const [item, storageKey] of [
        ["theme", "cockpit-context-theme"],
        ["locale", "cockpit-context-locale"],
        ["interface", "cockpit-context-ui-preferences"],
        ["recovery", "cockpit-context:stale-build-reload-at"],
      ]) {
        expect(lookup(tree, `sections.cookies.items.${item}.detail`)).toContain(storageKey);
      }
    }
    expect(lookup(bundles["en-US"], "sections.cookies.body")).toMatch(/no analytics/);
    expect(lookup(bundles["en-US"], "sections.cookies.body")).toMatch(/tracking/);
    // The banner and its "Cookie preferences" control are gone; the notice must
    // not point at them.
    for (const tree of Object.values(bundles)) {
      for (const key of leafKeys(tree)) {
        expect(String(lookup(tree, key)), key).not.toMatch(
          /Cookie preferences|Preferencias de cookies|cookie choice|decisión sobre cookies/,
        );
      }
    }
  });

  it("names the AI provider the server sends questions and source code to", () => {
    const recipients = lookup(bundles["en-US"], "sections.recipients.items.openrouter.detail");
    expect(recipients).toMatch(/OpenRouter/);
    expect(recipients).toMatch(/source code/);
  });
});

describe("conversationRetentionCopy", () => {
  async function render(locale: "en-US" | "es-MX", days: number): Promise<string> {
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      resources: { "en-US": { privacy: enPrivacy }, "es-MX": { privacy: esPrivacy } },
      ns: ["privacy"],
      defaultNS: "privacy",
      interpolation: { escapeValue: false },
    });
    const copy = conversationRetentionCopy(days);
    return i18n.t(`sections.retention.items.conversations.${copy.key}`, { count: copy.count });
  }

  it("states the configured number of days, not a hard-coded default", async () => {
    expect(conversationRetentionCopy(30)).toEqual({ key: "detailAfterDays", count: 30 });
    expect(await render("en-US", 30)).toMatch(/^Deleted automatically .* for 30 days, /);
    expect(await render("en-US", 1)).toMatch(/ for 1 day, /);
    expect(await render("es-MX", 30)).toMatch(/durante 30 días, /);
    expect(await render("es-MX", 1)).toMatch(/durante 1 día, /);
    for (const locale of ["en-US", "es-MX"] as const) {
      expect(await render(locale, 30)).not.toMatch(/\b90\b/);
    }
  });

  it("says conversations are kept until deleted when retention is 0", async () => {
    expect(conversationRetentionCopy(0)).toEqual({ key: "detailKept" });
    expect(await render("en-US", 0)).toMatch(/^Kept until you delete them/);
    expect(await render("es-MX", 0)).toMatch(/^Se guardan hasta que las borres/);
    for (const locale of ["en-US", "es-MX"] as const) {
      expect(await render(locale, 0)).not.toMatch(/\d+ (days|días)/);
    }
  });
});
