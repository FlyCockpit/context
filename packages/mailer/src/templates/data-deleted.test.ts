import { describe, expect, it } from "vitest";
import { renderDataDeleted } from "./data-deleted.js";

const notice = {
  locale: "en-US",
  name: "20260101_remove",
  effects: "old data",
  deletedAt: new Date("2026-01-01Z"),
  backup: "before.dump",
  note: "planned",
};

describe("renderDataDeleted", () => {
  it.each(["en-US", "es-MX"])("renders planned deletion and recovery guidance in %s", (locale) => {
    const { subject, html } = renderDataDeleted({ ...notice, locale });
    expect(html).toContain(`<html lang="${locale}">`);
    expect(html).toContain("before.dump");
    expect(html).toContain("2026-01-01T00:00:00.000Z");
    expect(html).toContain("20260101_remove");
    expect(html).toContain("planned");
    expect(subject).toBe(
      locale === "en-US"
        ? "Planned data deletion completed"
        : "Se completó la eliminación programada de datos",
    );
    expect(html).toContain(
      locale === "en-US" ? "only the data you need" : "solo los datos que necesitas",
    );
  });

  it.each(["en-US", "es-MX"])("handles missing backup, effects, and notes in %s", (locale) => {
    const { html } = renderDataDeleted({
      ...notice,
      locale,
      backup: null,
      effects: null,
      note: null,
    });
    expect(html).not.toContain("before.dump");
    expect(html).not.toContain("null");
    expect(html).toContain(
      locale === "en-US" ? "No backup was taken" : "No se realizó un respaldo",
    );
  });

  it("escapes every migration-supplied field and falls back to English", () => {
    const text = `<script>&"'`;
    const { html } = renderDataDeleted({
      ...notice,
      locale: "unknown",
      name: text,
      effects: text,
      note: text,
      backup: text,
    });
    expect(html.match(/&lt;script&gt;&amp;&quot;&#39;/g)).toHaveLength(4);
    expect(html).not.toContain("<script>");
    expect(html).toContain('<html lang="en-US">');
  });
});
