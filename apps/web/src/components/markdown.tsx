import { CodeSnippet } from "@cockpit-context/ui/components/code-snippet";
import { createContext, memo, useContext, useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

import { WideContent } from "@/components/wide-content";
import { parseFileReference, type SourceLinks } from "@/lib/source-links";

/**
 * Markdown written by the model (answers, checkout overviews) or edited by the
 * user, both untrusted. Raw HTML is never rendered: react-markdown shows it as
 * text (no rehype-raw). URLs go through react-markdown's default
 * `urlTransform` (no `javascript:`), links open in a new tab without an
 * opener or referrer, images are links (a text cannot make the browser fetch
 * a URL by itself), code blocks are `CodeSnippet`s (copyable, scrolling on
 * their own) and wide tables scroll on their own. Inside a
 * `SourceLinksContext` (a conversation on a public GitHub/GitLab source),
 * inline code citing a file (`src/a.ts:12-20`) links to it at the commit.
 * Ported from ws-model-proxy's chat-markdown.
 */
type HastText = { type?: string; value?: unknown; children?: HastText[] };

/** The plain text of a hast subtree (a code block's source). */
function textOf(node: HastText | undefined): string {
  if (!node) return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

/**
 * Where the rendered answers' cited files live: provided only around a
 * conversation's transcript; null (the default) renders citations as code.
 */
export const SourceLinksContext = createContext<SourceLinks | null>(null);

const CITATION_LINK_CLASS_NAME =
  "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type HastElement = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastElement[];
  value?: unknown;
};

/**
 * Wraps inline code citing a file (not in a code block, not already inside a
 * link) in a link to that file at the commit; the `a` component then opens it
 * in a new tab without an opener or referrer.
 */
function rehypeSourceLinks(links: SourceLinks) {
  const visit = (node: HastElement, inLinkOrPre: boolean) => {
    const children = node.children;
    if (!children) return;
    children.forEach((child, index) => {
      if (child.type !== "element") return;
      const blocked = inLinkOrPre || child.tagName === "a" || child.tagName === "pre";
      if (child.tagName === "code" && !inLinkOrPre) {
        const only = child.children?.length === 1 ? child.children[0] : undefined;
        const ref =
          only?.type === "text" && typeof only.value === "string"
            ? parseFileReference(only.value)
            : null;
        if (ref) {
          children[index] = {
            type: "element",
            tagName: "a",
            properties: { href: links.file(ref), className: [CITATION_LINK_CLASS_NAME] },
            children: [child],
          };
        }
        return;
      }
      visit(child, blocked);
    });
  };
  return (tree: HastElement) => visit(tree, false);
}

function buildComponents(copyLabel: string): Components {
  return {
    a: ({ node: _node, children, href, ...props }) => {
      // A URL the default transform dropped (`javascript:` and the like) is text.
      if (!href) return <span>{children}</span>;
      // In-answer targets (footnotes) stay in the page.
      if (href.startsWith("#")) {
        return (
          <a {...props} href={href}>
            {children}
          </a>
        );
      }
      return (
        <a {...props} href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    // An answer's headings sit below the page's own.
    h1: ({ node: _node, ...props }) => <h3 {...props} />,
    h2: ({ node: _node, ...props }) => <h4 {...props} />,
    h3: ({ node: _node, ...props }) => <h5 {...props} />,
    h4: ({ node: _node, ...props }) => <h6 {...props} />,
    h5: ({ node: _node, ...props }) => <h6 {...props} />,
    img: ({ src, alt }) =>
      typeof src === "string" && src ? (
        <a href={src} target="_blank" rel="noopener noreferrer">
          {alt || src}
        </a>
      ) : (
        (alt ?? null)
      ),
    pre: ({ node }) => (
      <CodeSnippet
        code={textOf(node as HastText | undefined).replace(/\n$/, "")}
        copyLabel={copyLabel}
        preClassName="leading-relaxed"
      />
    ),
    table: ({ node: _node, ...props }) => (
      <WideContent>
        <table {...props} />
      </WideContent>
    ),
  };
}

type HastNode = {
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const FOOTNOTE_LABEL_ID = "footnote-label";

/** `clobberPrefix` leaves the footnote section's label id fixed: prefix it and its references. */
function rehypePrefixFootnoteLabel(prefix: string) {
  const prefixed = `${prefix}${FOOTNOTE_LABEL_ID}`;
  const visit = (node: HastNode) => {
    const properties = node.properties;
    if (properties) {
      if (properties.id === FOOTNOTE_LABEL_ID) properties.id = prefixed;
      const describedBy = properties.ariaDescribedBy;
      if (Array.isArray(describedBy)) {
        properties.ariaDescribedBy = describedBy.map((id) =>
          id === FOOTNOTE_LABEL_ID ? prefixed : id,
        );
      }
    }
    node.children?.forEach(visit);
  };
  return (tree: HastNode) => visit(tree);
}

const MARKDOWN_CLASS_NAME =
  "min-w-0 max-w-full break-words text-sm leading-relaxed [&>*+*]:mt-3 [&_a]:text-primary-text [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground [&_code]:font-mono [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[length:max(0.9em,0.75rem)] [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:text-base [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold [&_hr]:border-border [&_li]:ms-5 [&_ol]:list-decimal [&_sup]:text-xs [&_ul]:list-disc [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-start";

/** Model-written (or user-edited) markdown; re-renders only when its text changes. */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  // Footnote ids stay unique when several answers have footnotes.
  const id = useId();
  const { t } = useTranslation(["common"]);
  const copyLabel = t("common:actions.copy");
  const links = useContext(SourceLinksContext);
  const components = useMemo(() => buildComponents(copyLabel), [copyLabel]);
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(
    () => [
      [rehypePrefixFootnoteLabel, `${id}-`],
      ...(links
        ? [[rehypeSourceLinks, links] satisfies [typeof rehypeSourceLinks, SourceLinks]]
        : []),
    ],
    [id, links],
  );
  return (
    <div className={MARKDOWN_CLASS_NAME}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ clobberPrefix: `${id}-` }}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
