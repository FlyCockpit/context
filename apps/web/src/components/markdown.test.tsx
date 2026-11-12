import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "@/components/markdown";

function render(content: string) {
  return renderToStaticMarkup(<Markdown content={content} />);
}

describe("Markdown", () => {
  it("renders GitHub-flavored markdown", () => {
    const html = render("## Usage\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done");
    expect(html).toContain("<h4>Usage</h4>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
  });

  it("never renders raw HTML or script URLs", () => {
    const html = render('<img src=x onerror="alert(1)"> [click](javascript:alert(1))');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span>click</span>");
  });

  it("renders code blocks as copyable snippets with their source text", () => {
    const html = render("```ts\nconst a = 1 < 2;\n```");
    expect(html).toContain('data-slot="code-snippet"');
    expect(html).toContain("const a = 1 &lt; 2;</pre>");
  });

  it("turns images into links and opens links without an opener", () => {
    const html = render("![logo](https://example.com/a.png) [docs](https://example.com)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/a.png"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
