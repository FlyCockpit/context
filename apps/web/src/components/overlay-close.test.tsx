import { AlertDialogCancel } from "@cockpit-context/ui/components/alert-dialog";
import { DialogContent } from "@cockpit-context/ui/components/dialog";
import { SheetContent } from "@cockpit-context/ui/components/sheet";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

/**
 * Class contract for the shared overlay close targets (docs/ui.md § Edge
 * lines). jsdom has no layout, so the arithmetic lives in the doc and these
 * tests pin the classes it depends on.
 */
type CloseRender = ReactElement<{ className: string; size: string }>;

function closeButton(Content: typeof DialogContent | typeof SheetContent, slot: string) {
  const root = Content({ closeLabel: "Close", children: "Body" });
  if (!isValidElement<{ children: ReactNode }>(root)) throw new Error("Missing portal");
  const popup = Children.toArray(root.props.children).find(
    (child) =>
      isValidElement<{ "data-slot"?: string }>(child) &&
      child.props["data-slot"] === `${slot}-content`,
  );
  if (!isValidElement<{ children: ReactNode }>(popup)) throw new Error("Missing popup");
  const close = Children.toArray(popup.props.children).find(
    (child) =>
      isValidElement<{ "data-slot"?: string }>(child) &&
      child.props["data-slot"] === `${slot}-close`,
  );
  if (!isValidElement<{ render: CloseRender }>(close)) throw new Error("Missing close button");
  return close.props.render.props;
}

describe("overlay close buttons", () => {
  it.each([
    ["dialog", DialogContent],
    ["sheet", SheetContent],
  ] as const)("draws the %s close focus ring inside the box", (slot, Content) => {
    const classes = closeButton(Content, slot).className.split(" ");
    expect(classes).toContain("focus-visible:ring-inset");
    expect(classes).toContain("focus-visible:ring-offset-0");
  });

  it("centres a 44px hit square on the 28px dialog close", () => {
    const { className, size } = closeButton(DialogContent, "dialog");
    // `icon-sm` is 28px at every width here; an inset expansion is measured
    // from the padding box, inside the 1px border (`-inset-2` gave 42px).
    expect(size).toBe("icon-sm");
    const classes = className.split(" ");
    for (const part of [
      "after:absolute",
      "after:top-1/2",
      "after:left-1/2",
      "after:size-11",
      "after:-translate-x-1/2",
      "after:-translate-y-1/2",
      // 8px past the 28px box: at right-2 the square ends on the popup edge.
      "right-2",
      // 12 + 14 = 26px: the button's centre is the p-4 title line's centre.
      "top-3",
    ])
      expect(classes).toContain(part);
    expect(className).not.toMatch(/after:-?inset-/);
  });

  it("gives the sheet close a 44px box flush with the edge", () => {
    const { className, size } = closeButton(SheetContent, "sheet");
    expect(size).toBe("icon-touch");
    const classes = className.split(" ");
    expect(classes).toContain("top-1");
    expect(classes).toContain("right-0");
    expect(className).not.toMatch(/after:/);
  });
});

it("keeps AlertDialogCancel at least 44px while preserving caller classes", () => {
  const element = AlertDialogCancel({ className: "w-full", children: "Cancel" });
  const classes = String(element.props.className).split(" ");
  expect(classes).toEqual(expect.arrayContaining(["min-h-11", "min-w-11", "w-full"]));
  expect(element.props.children).toBe("Cancel");
});

describe("wide sheet safe areas", () => {
  it("keeps a full-screen phone sheet and its close button clear of the notch", () => {
    const root = SheetContent({ closeLabel: "Close", size: "wide", children: "Body" });
    if (!isValidElement<{ children: ReactNode }>(root)) throw new Error("Missing portal");
    const popup = Children.toArray(root.props.children).find(
      (child) =>
        isValidElement<{ "data-slot"?: string }>(child) &&
        child.props["data-slot"] === "sheet-content",
    );
    if (!isValidElement<{ className: string }>(popup)) throw new Error("Missing popup");
    expect(popup.props.className).toContain("data-[size=wide]:pt-(--safe-area-top)");
    const close = closeButton(SheetContent, "sheet").className.split(" ");
    expect(close).toContain("in-data-[size=wide]:top-[calc(var(--safe-area-top)+0.25rem)]");
  });
});
