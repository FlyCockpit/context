import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Without SMTP the form must still say that password reset is unavailable
 * (docs/product.md): always from `sm` up, behind a label-row toggle on phones
 * so the login page's sign-up link stays above the BottomNav at 320×568.
 * Rendered to static markup (no layout), with `useState` driven by a harness.
 */
const harness = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0 }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (harness.state[index] === undefined) harness.state[index] = initial;
    return [
      harness.state[index],
      (value: unknown) => {
        const prev = harness.state[index];
        harness.state[index] =
          typeof value === "function" ? (value as (p: unknown) => unknown)(prev) : value;
      },
    ];
  },
  useId: () => "note-id",
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a data-to={to} className={className ?? ""}>
      {children}
    </a>
  ),
}));

const { PasswordHelp } = await import("./password-help");

function render(passwordResetAvailable: boolean) {
  harness.cursor = 0;
  return renderToStaticMarkup(
    <PasswordHelp
      lang="en-US"
      redirectTo="/en-US/ongoing"
      passwordResetAvailable={passwordResetAvailable}
    />,
  );
}

function findButton(node: ReactNode): ReactElement<{ onClick: () => void }> | null {
  if (!isValidElement(node)) return null;
  if (node.type === "button") return node as ReactElement<{ onClick: () => void }>;
  const { children } = node.props as { children?: ReactNode };
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child);
    if (found) return found;
  }
  return null;
}

describe("PasswordHelp", () => {
  beforeEach(() => {
    harness.state = [];
  });

  it("with SMTP links to the reset flow from the label row on phones, and shows no note", () => {
    const html = render(true);
    expect(html).toContain('data-to="/$lang/forgot-password"');
    expect(html).toContain("max-sm:absolute");
    expect(html).not.toContain("auth:login.passwordResetUnavailable");
    expect(html).not.toContain("<button");
  });

  it("without SMTP always shows the note from sm up and hides it on phones until the toggle opens it", () => {
    const closed = render(false);
    expect(closed).not.toContain("forgot-password");
    expect(closed).toMatch(
      /<div class="[^"]*sm:hidden[^"]*"><button type="button" aria-expanded="false" aria-controls="note-id"/,
    );
    expect(closed).toMatch(
      /<p id="note-id" class="[^"]*max-sm:hidden[^"]*">auth:login.passwordResetUnavailable<\/p>/,
    );

    harness.cursor = 0;
    const tree = PasswordHelp({ lang: "en-US", redirectTo: "/", passwordResetAvailable: false });
    const button = findButton(tree);
    expect(button).not.toBeNull();
    button?.props.onClick();

    const open = render(false);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toMatch(/<p id="note-id" class="text-sm text-muted-foreground">/);
  });
});
