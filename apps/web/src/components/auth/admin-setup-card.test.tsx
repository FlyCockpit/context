import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a data-to={to}>{children}</a>,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/auth/auth-screen", () => ({
  AuthCard: ({
    title,
    description,
    children,
  }: {
    title: string;
    description: string;
    children: ReactNode;
  }) => (
    <section data-title={title} data-description={description}>
      {children}
    </section>
  ),
}));

const { AdminSetupCard } = await import("./admin-setup-card");

function render(props: Partial<Parameters<typeof AdminSetupCard>[0]>) {
  return renderToStaticMarkup(
    <AdminSetupCard state="configure" lang="en-US" redirectTo={undefined} {...props} />,
  );
}

describe("AdminSetupCard", () => {
  it("asks to set ADMIN_EMAILS and restart", () => {
    expect(render({})).toContain('data-description="auth:adminSetup.configureDescription"');
  });

  it("explains the FORCE_SSO bootstrap sequence when password sign-up is off", () => {
    expect(render({ forceSso: true })).toContain(
      'data-description="auth:adminSetup.configureForceSsoDescription"',
    );
  });

  it("points a locked server at the promotion recovery", () => {
    expect(render({ state: "locked", forceSso: true })).toContain(
      'data-description="auth:adminSetup.lockedDescription"',
    );
  });

  it("links the open bootstrap to the setup form", () => {
    expect(render({ state: "bootstrap" })).toContain('<a data-to="/$lang/signup">');
  });
});
