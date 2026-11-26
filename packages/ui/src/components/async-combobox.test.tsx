import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const popover = vi.hoisted(() => ({ open: false }));

// Static markup cannot open the popover, so a test can render its content
// in place to check the search input's name.
vi.mock("@cockpit-context/ui/components/popover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./popover")>();
  return {
    ...actual,
    PopoverContent: ({ children }: { children: ReactNode }) =>
      popover.open ? <div data-testid="content">{children}</div> : null,
  };
});

import { AsyncCombobox } from "./async-combobox";

type Item = { id: string; name: string };

function render(props: { label?: string; value?: Item | null }, opts: { open?: boolean } = {}) {
  popover.open = opts.open ?? false;
  return renderToStaticMarkup(
    <AsyncCombobox<Item>
      {...props}
      onSearch={async () => []}
      onSelect={() => {}}
      getKey={(item) => item.id}
      getLabel={(item) => item.name}
      renderItem={(item) => item.name}
      placeholder="All packages"
      searchPlaceholder="Search packages…"
    />,
  );
}

function labelledBy(html: string): string[] {
  const ids =
    /role="combobox"[^>]*aria-labelledby="([^"]+)"|aria-labelledby="([^"]+)"[^>]*role="combobox"/.exec(
      html,
    );
  const value = ids?.[1] ?? ids?.[2];
  if (!value) return [];
  return value.split(" ").map((id) => {
    const match = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html);
    return match?.[1] ?? `missing:${id}`;
  });
}

describe("AsyncCombobox accessible name (CTX-11)", () => {
  it("names the trigger with the label, then the placeholder", () => {
    expect(labelledBy(render({ label: "Filter by package" }))).toEqual([
      "Filter by package",
      "All packages",
    ]);
  });

  it("keeps announcing the selected value after the label", () => {
    expect(
      labelledBy(render({ label: "Filter by package", value: { id: "p1", name: "npm:zod" } })),
    ).toEqual(["Filter by package", "npm:zod"]);
  });

  it("adds no labelling without a label", () => {
    expect(render({})).not.toContain("aria-labelledby");
  });

  it("names the search input after the search placeholder (through cmdk's label)", () => {
    const html = render({ label: "Filter by package" }, { open: true });
    const input = /<input[^>]*>/.exec(html)?.[0] ?? "";
    const labelledby = /aria-labelledby="([^"]+)"/.exec(input)?.[1];
    expect(labelledby).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${labelledby}"[^>]*>Search packages…<`));
  });
});
