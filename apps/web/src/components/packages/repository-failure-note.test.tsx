import enAdmin from "@cockpit-context/locales/src/en-US/admin.json";
import enDashboard from "@cockpit-context/locales/src/en-US/dashboard.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { RepositoryFailureNote } from "./repository-failure-note";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { admin: enAdmin, dashboard: enDashboard } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

const render = (reason: string | null, audience: "owner" | "admin") =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RepositoryFailureNote reason={reason} audience={audience} />
    </I18nextProvider>,
  );

describe("RepositoryFailureNote", () => {
  it("gives the owner the reason and a next step, and the admin who can fix it", () => {
    expect(render("auth", "owner")).toContain(enDashboard.packages.repositoryFailure.auth);
    expect(render("auth", "admin")).toContain(enAdmin.storage.repositoryFailure.auth);
  });

  it("has a text for every reason the server sends, in both audiences", () => {
    const reasons = Object.keys(enDashboard.packages.repositoryFailure);
    expect(Object.keys(enAdmin.storage.repositoryFailure).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      expect(render(reason, "owner")).not.toContain("repositoryFailure");
      expect(render(reason, "admin")).not.toContain("repositoryFailure");
    }
  });

  it("falls back to the general text for an unknown reason, and shows nothing without one", () => {
    expect(render("newReason", "owner")).toContain(enDashboard.packages.repositoryFailure.other);
    expect(render(null, "owner")).toBe("");
  });
});
