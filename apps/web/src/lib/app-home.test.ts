import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  redirect: (options: Record<string, unknown>) => ({ redirect: options }),
}));

const { APP_HOME, appHomeHref } = await import("./app-home");
const { Route: DashboardRoute } = await import("@/routes/$lang/dashboard");

describe("APP_HOME", () => {
  it("is Ongoing, the conversations home", () => {
    expect(APP_HOME).toBe("/$lang/ongoing");
  });

  it("fills in the locale", () => {
    expect(appHomeHref("es-MX")).toBe("/es-MX/ongoing");
  });
});

describe("/$lang/dashboard", () => {
  const options = (DashboardRoute as unknown as { options: Record<string, unknown> }).options;

  it("only forwards to the signed-in home, keeping the locale and replacing the entry", () => {
    const beforeLoad = options.beforeLoad as (ctx: { params: { lang: string } }) => void;
    expect(() => beforeLoad({ params: { lang: "es-MX" } })).toThrow();
    try {
      beforeLoad({ params: { lang: "es-MX" } });
    } catch (thrown) {
      expect(thrown).toEqual({
        redirect: { to: "/$lang/ongoing", params: { lang: "es-MX" }, replace: true },
      });
    }
  });

  it("has no page and no session lookup of its own", () => {
    expect(options.component).toBeUndefined();
    expect(options.loader).toBeUndefined();
  });
});
