import { describe, expect, it } from "vitest";
import { renderOperationalFailure } from "./operational-failure.js";

describe("renderOperationalFailure", () => {
  it.each(["en-US", "es-MX"])("renders job and summary failures in %s", (locale) => {
    const job = renderOperationalFailure({
      kind: "job",
      type: "repo.fetch",
      id: "job-1",
      attempts: 3,
      error: "down",
      locale,
    });
    expect(job.html).toContain(`<html lang="${locale}">`);
    expect(job.html).toContain("job-1");
    expect(job.subject).toContain(locale === "en-US" ? "background job failed" : "falló una tarea");
    const summary = renderOperationalFailure({
      kind: "summary",
      type: "checkout.summarize",
      runId: "run-1",
      checkoutId: "checkout-1",
      error: "down",
      locale,
    });
    expect(summary.html).toContain("run-1");
    expect(summary.html).toContain("checkout-1");
    expect(summary.html).toContain(locale === "en-US" ? "regenerate" : "volver a generarlo");
  });

  it("escapes failure details and falls back to English", () => {
    const { html } = renderOperationalFailure({
      kind: "job",
      type: "<type>",
      id: "<id>",
      attempts: 1,
      error: `<script>&"'`,
      locale: "unknown",
    });
    expect(html).toContain("&lt;script&gt;&amp;&quot;&#39;");
    expect(html).toContain("&lt;type&gt;");
    expect(html).toContain("&lt;id&gt;");
    expect(html).toContain('<html lang="en-US">');
    expect(html).not.toContain("<script>");
  });
});
