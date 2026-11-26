import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Field triage for the package form (docs/ui.md § Form surfaces):
 * the quick path (ecosystem, name, git URL) is up front; display name,
 * subdirectory, tag pattern, default ref and notes sit in one collapsed
 * Advanced section whose summary shows their current values. Edit and approve
 * use the same split as create.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { value?: string }) =>
      options?.value === undefined ? key : `${key}(${options.value})`,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/keys">{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ isPending: false, data: undefined, mutate: () => undefined }),
  useQuery: () => ({ isPending: true, isError: false, data: undefined }),
}));
vi.mock("@/utils/friendly-error", () => ({
  errorReason: (error: { reason?: string } | null) => error?.reason ?? null,
  friendly: (error: { reason?: string } | null) => `friendly:${error?.reason ?? "none"}`,
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    packages: { lookupRegistry: { mutationOptions: () => ({}) } },
    sshKeys: { list: { queryOptions: () => ({}) } },
  },
}));

const { PackageForm, showRefusalAtField } = await import("./package-form");
const { emptyPackageForm } = await import("@/lib/packages");

function render(mode: "create" | "approve" | "edit", values = emptyPackageForm()) {
  return renderToStaticMarkup(
    <PackageForm
      mode={mode}
      surface="sheet"
      lang="en-US"
      initialValues={values}
      onSubmit={async () => undefined}
      onCancel={() => undefined}
      submitLabel="Add package"
      pendingLabel="Adding…"
    />,
  );
}

/** The markup before and inside the Advanced `<details>`. */
function split(html: string) {
  const start = html.indexOf("<details");
  const end = html.indexOf("</details>");
  expect(start).toBeGreaterThan(-1);
  return { quick: html.slice(0, start), advanced: html.slice(start, end), tail: html.slice(end) };
}

const ADVANCED_LABELS = [
  "dashboard:packages.form.displayName",
  "dashboard:packages.form.subdirectory",
  "dashboard:packages.form.tagPattern",
  "dashboard:packages.form.defaultRef",
  "dashboard:packages.form.notes",
];

describe("PackageForm field triage", () => {
  it.each(["create", "approve", "edit"] as const)(
    "%s: keeps the git URL up front and the expert fields in a collapsed Advanced section",
    (mode) => {
      const { quick, advanced, tail } = split(render(mode));
      expect(quick).toContain("dashboard:packages.form.gitUrl");
      for (const label of ADVANCED_LABELS) {
        expect(quick).not.toContain(`>${label}<`);
        expect(advanced).toContain(`>${label}<`);
      }
      expect(advanced).not.toMatch(/^<details[^>]*\sopen/);
      expect(advanced).toContain("dashboard:packages.form.advanced");
      // The primary action follows the fields, outside the scrolling body.
      expect(tail).toContain('type="submit"');
    },
  );

  it("create: ecosystem and name are the first decisions", () => {
    const { quick } = split(render("create"));
    expect(quick.indexOf("dashboard:packages.form.ecosystem")).toBeLessThan(
      quick.indexOf("dashboard:packages.form.gitUrl"),
    );
    expect(quick).toContain("dashboard:packages.form.name");
  });

  it("summarizes the hidden values while collapsed", () => {
    const { advanced } = split(
      render("edit", {
        ...emptyPackageForm(),
        name: "react-query",
        displayName: "TanStack Query",
        subdirectory: "packages/react-query",
        notes: "Use v5.",
      }),
    );
    expect(advanced).toContain("dashboard:packages.form.summary.displayName(TanStack Query)");
    expect(advanced).toContain(
      "dashboard:packages.form.summary.subdirectory(packages/react-query)",
    );
    expect(advanced).toContain(
      "dashboard:packages.form.summary.tagPattern(dashboard:packages.form.summary.auto)",
    );
    expect(advanced).toContain(
      "dashboard:packages.form.summary.defaultRef(dashboard:packages.form.summary.remoteDefault)",
    );
    expect(advanced).toContain("dashboard:packages.form.summary.notesSet");
  });
});

describe("showRefusalAtField", () => {
  function root(present: boolean) {
    const target = { closest: () => null, focus: vi.fn(), scrollIntoView: vi.fn() };
    return {
      target,
      element: {
        querySelector: vi.fn((selector: string) =>
          present &&
          (selector === '[id$="-gitUrl"]' || selector === '[aria-invalid="true"]:not(:disabled)')
            ? target
            : null,
        ),
      } as unknown as HTMLElement,
    };
  }

  it("puts a git URL refusal under the git URL field and focuses it", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 0;
    });
    const { element, target } = root(true);
    const setFieldError = vi.fn();
    expect(showRefusalAtField({ reason: "HOST_UNRESOLVABLE" }, element, setFieldError)).toBe(true);
    expect(setFieldError).toHaveBeenCalledWith("gitUrl", "friendly:HOST_UNRESOLVABLE");
    expect(target.focus).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("leaves refusals without a field, or for a field not on screen, to the toast", () => {
    const setFieldError = vi.fn();
    expect(showRefusalAtField({ reason: "GIT_TIMEOUT" }, root(true).element, setFieldError)).toBe(
      false,
    );
    expect(
      showRefusalAtField({ reason: "INVALID_REMOTE_URL" }, root(false).element, setFieldError),
    ).toBe(false);
    expect(showRefusalAtField(new Error("network"), null, setFieldError)).toBe(false);
    expect(setFieldError).not.toHaveBeenCalled();
  });
});
