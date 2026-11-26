import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CTX-02: the nudge sits above full-height pages (a conversation), so it must
 * stay one compact row with the explanation behind a disclosure. Rendered to
 * static markup: the contract is pinned through structure and classes; the
 * real heights are checked in a browser at 390 and 1280.
 */
const fixture = vi.hoisted(() => ({
  status: "grace" as "grace" | "blocked" | "not-required" | "enrolled",
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a data-to={to} className={className ?? ""}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: {} }) }));
vi.mock("@/utils/orpc", () => ({
  orpc: { settings: { getAll: { queryOptions: () => ({}) } } },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: {
      status: "authenticated",
      session: { user: { twoFactorEnabled: false, role: "admin", createdAt: new Date() } },
    },
  }),
}));
vi.mock("@/utils/two-factor-policy", () => ({
  twoFactorEnrollmentState: () =>
    fixture.status === "grace"
      ? { status: "grace", deadlineMs: Date.now() + 23 * 3_600_000 + 60_000 }
      : { status: fixture.status },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { deadline?: string }) =>
      values?.deadline ? `${key}(${values.deadline})` : key,
    i18n: { language: "en-US" },
  }),
}));

const { TwoFactorNudge } = await import("./two-factor-nudge");

beforeEach(() => {
  fixture.status = "grace";
});

describe("TwoFactorNudge", () => {
  it("is one compact row: short title with the deadline, a disclosure and the action", () => {
    const html = renderToStaticMarkup(<TwoFactorNudge />);
    expect(html).toMatch(/^<div role="alert" class="shrink-0 /);
    expect(html).toContain("twoFactorNudge.requiredTitle(in 23 hours)");
    expect(html).toMatch(/<button type="button" aria-expanded="false" aria-controls="([^"]+)"/);
    expect(html).toContain('<a data-to="/$lang/settings/security"');
    // The explanation is in the markup but collapsed until asked for.
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(new RegExp(`<div id="${controls}" hidden=""`));
    expect(html).toContain("twoFactorNudge.requiredMessage(in 23 hours)");
    expect(html).toContain("twoFactorNudge.configurable");
  });

  it("keeps the advisory voice when enforcement is off", () => {
    fixture.status = "not-required";
    const html = renderToStaticMarkup(<TwoFactorNudge />);
    expect(html).toContain("twoFactorNudge.title");
    expect(html).toContain("twoFactorNudge.message");
  });

  it("renders nothing once enrolled", () => {
    fixture.status = "enrolled";
    expect(renderToStaticMarkup(<TwoFactorNudge />)).toBe("");
  });
});
