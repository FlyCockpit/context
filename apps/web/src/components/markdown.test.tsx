import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown, SourceLinksContext } from "@/components/markdown";
import { sourceLinks } from "@/lib/source-links";

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

  describe("file citations", () => {
    const sha = "a".repeat(40);
    const links = sourceLinks("https://github.com/TanStack/query", sha);
    const withLinks = (content: string) =>
      renderToStaticMarkup(
        <SourceLinksContext value={links}>
          <Markdown content={content} />
        </SourceLinksContext>,
      );

    it("links a cited path to that file and lines at the commit, keeping the code", () => {
      const html = withLinks("See `packages/react-query/src/queryOptions.ts:44-58` for it.");
      expect(html).toContain(
        `<a class="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href="https://github.com/TanStack/query/blob/${sha}/packages/react-query/src/queryOptions.ts#L44-L58" target="_blank" rel="noopener noreferrer"><code>packages/react-query/src/queryOptions.ts:44-58</code></a>`,
      );
    });

    it("leaves other inline code, code blocks and code inside links alone", () => {
      const html = withLinks(
        "Call `useQuery()` from `@tanstack/react-query`; [`docs.md`](https://example.com).\n\n```\nsrc/index.ts:3\n```",
      );
      expect(html).toContain("<code>useQuery()</code>");
      expect(html).not.toContain('<a href="https://github.com');
      expect(html).toContain(
        '<a href="https://example.com" target="_blank" rel="noopener noreferrer"><code>docs.md</code></a>',
      );
      expect(html).toContain("src/index.ts:3</pre>");
    });

    it("renders citations as plain code without a linkable source", () => {
      const content = "See `src/index.ts:12`.";
      const html = render(content);
      expect(html).toBe(
        renderToStaticMarkup(
          <SourceLinksContext value={sourceLinks("git@github.com:o/r.git", sha)}>
            <Markdown content={content} />
          </SourceLinksContext>,
        ),
      );
      expect(html).toContain("<code>src/index.ts:12</code>");
      expect(html).not.toContain("<a");
    });
  });
});
