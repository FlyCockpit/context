/**
 * The structure of the public privacy notice (`/$lang/privacy`). The copy lives
 * in the `privacy` namespace (packages/locales/src/<locale>/privacy.json); this
 * list fixes the section order and which keys each section renders, so the page
 * and the locale-parity test read the same shape.
 *
 * The inventory must match the code and the deployed configuration. When a
 * feature starts storing or sending something new, update the copy here and
 * docs/product.md in the same change. The rules are in
 * docs/product.md § Sharing and privacy
 */

export type PrivacySection = {
  id: string;
  /** Paragraphs under `sections.<id>.<key>`, rendered before the items. */
  paragraphs: readonly string[];
  /** Definition items under `sections.<id>.items.<key>.term` / `.detail`. */
  items: readonly string[];
  /** A closing paragraph under `sections.<id>.note`. */
  note?: boolean;
  /**
   * The section shows the operator's deploy-time identity (`appConfig.operator`,
   * from COCKPIT_CONTEXT_OPERATOR_NAME / COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL), with the keys under
   * `sections.<id>.contact.<key>` (OPERATOR_CONTACT_KEYS / REQUESTS_CONTACT_KEYS).
   */
  contact?: "operator" | "requests";
  /**
   * The item whose detail states the configured conversation retention
   * (`appConfig.conversationRetentionDays`, from
   * COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS). It renders RETENTION_DETAIL_KEYS under
   * `sections.<id>.items.<key>` instead of a fixed `.detail`.
   */
  retentionItem?: string;
};

/** Copy the configured-retention item renders (see `conversationRetentionCopy`). */
const RETENTION_DETAIL_KEYS = [
  "detailAfterDays_one",
  "detailAfterDays_other",
  "detailKept",
  "loadFailed",
] as const;

/**
 * Which retention sentence the notice shows for the configured number of
 * days: the plural "deleted after N days" copy, or "kept until you delete
 * them" when automatic deletion is off (`0`).
 */
export function conversationRetentionCopy(days: number): {
  key: "detailAfterDays" | "detailKept";
  count?: number;
} {
  return days > 0 ? { key: "detailAfterDays", count: days } : { key: "detailKept" };
}

/** Copy the operator-identity block renders in the "Who runs this server" section. */
const OPERATOR_CONTACT_KEYS = [
  "loadFailed",
  "named",
  "contactLabel",
  "noEmail",
  "unpublished",
] as const;
/** Copy the operator-identity block renders in the "Your requests" section. */
const REQUESTS_CONTACT_KEYS = ["loadFailed", "contactLabel", "unpublished"] as const;

export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
  { id: "operator", paragraphs: ["body"], items: [], contact: "operator" },
  {
    id: "collected",
    paragraphs: ["intro"],
    items: [
      "account",
      "twoFactor",
      "sessions",
      "sshKeys",
      "knownHosts",
      "connections",
      "packages",
      "conversations",
      "repositories",
      "logs",
      "browser",
    ],
  },
  {
    id: "recipients",
    paragraphs: ["intro"],
    items: ["openrouter", "gitHosts", "registries", "agentApps", "email", "backups", "hosting"],
    note: true,
  },
  { id: "access", paragraphs: [], items: ["owner", "admins", "operator"] },
  { id: "ai", paragraphs: ["body"], items: [] },
  {
    id: "retention",
    paragraphs: [],
    retentionItem: "conversations",
    items: [
      "conversations",
      "packages",
      "connections",
      "sessions",
      "repositories",
      "account",
      "backups",
      "elsewhere",
    ],
  },
  { id: "requests", paragraphs: ["body"], items: [], contact: "requests" },
  {
    id: "cookies",
    paragraphs: ["body"],
    // Strictly necessary only: Cockpit Context runs no analytics or tracking, so there is
    // no consent banner. A new cookie or storage key is added here and in
    // docs/product.md. See docs/product.md § Sharing and privacy
    items: ["session", "challenge", "theme", "locale", "interface", "offline", "recovery"],
    note: true,
  },
  { id: "children", paragraphs: ["body"], items: [] },
  { id: "changes", paragraphs: ["body"], items: [] },
];

/** Top-level keys outside `sections`. */
const PRIVACY_PAGE_KEYS = [
  "meta.title",
  "title",
  "updated",
  "intro",
  "footerLink",
  "signupNotice",
  "signupLink",
  "settingsTitle",
  "settingsDescription",
] as const;

/** Every key the page (and the links to it) render, without the namespace. */
export function privacyNoticeKeys(): string[] {
  const keys: string[] = [...PRIVACY_PAGE_KEYS];
  for (const section of PRIVACY_SECTIONS) {
    const base = `sections.${section.id}`;
    keys.push(`${base}.title`);
    for (const paragraph of section.paragraphs) keys.push(`${base}.${paragraph}`);
    for (const item of section.items) {
      keys.push(`${base}.items.${item}.term`);
      if (item === section.retentionItem) {
        for (const key of RETENTION_DETAIL_KEYS) keys.push(`${base}.items.${item}.${key}`);
      } else {
        keys.push(`${base}.items.${item}.detail`);
      }
    }
    if (section.note) keys.push(`${base}.note`);
    const contactKeys =
      section.contact === "operator"
        ? OPERATOR_CONTACT_KEYS
        : section.contact === "requests"
          ? REQUESTS_CONTACT_KEYS
          : [];
    for (const key of contactKeys) keys.push(`${base}.contact.${key}`);
  }
  return keys;
}
