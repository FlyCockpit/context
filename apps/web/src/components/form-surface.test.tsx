import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdvancedSection,
  FORM_SHEET_FOOTER_CLASS,
  FormSheetContent,
  focusFirstInvalid,
} from "./form-surface";

/**
 * Expert fields sit in a collapsed section whose summary shows the current
 * values, a long form is a wide sheet, and a failed submit lands focus on the
 * first invalid field. See docs/ui.md § Form surfaces
 */

describe("AdvancedSection", () => {
  it("starts collapsed and shows the summary of the hidden values", () => {
    const html = renderToStaticMarkup(
      <AdvancedSection title="Advanced" summary="Starts in packages/core · No notes">
        <input aria-label="Subdirectory" />
      </AdvancedSection>,
    );
    expect(html).toMatch(/^<details(?![^>]*\sopen)/);
    expect(html).toContain("Advanced");
    expect(html).toContain("Starts in packages/core · No notes");
    expect(html).toContain('aria-label="Subdirectory"');
  });

  it("opens when asked", () => {
    const html = renderToStaticMarkup(
      <AdvancedSection title="Advanced" defaultOpen>
        <span />
      </AdvancedSection>,
    );
    expect(html).toMatch(/^<details[^>]*\sopen/);
  });
});

describe("FormSheetContent", () => {
  it("is a right sheet that is full width on phones and wide from 1024px", () => {
    const element = FormSheetContent({ closeLabel: "Close", children: "Body" }) as ReactElement<{
      className: string;
      style: Record<string, string>;
      "data-form-surface": string;
    }>;
    expect(isValidElement(element)).toBe(true);
    expect(element.props["data-form-surface"]).toBe("sheet");
    const classes = element.props.className.split(" ");
    expect(classes).toContain("data-[side=right]:w-full");
    expect(classes).toContain("data-[side=right]:lg:max-w-3xl");
  });

  it("keeps clear of the notch and the home indicator on a full-screen phone sheet", () => {
    const element = FormSheetContent({ closeLabel: "Close", children: "Body" }) as ReactElement<{
      className: string;
      style: Record<string, string>;
    }>;
    expect(element.props.style.paddingTop).toBe("var(--safe-area-top)");
    expect(element.props.className).toContain(
      "[&>[data-slot=sheet-close]]:top-[calc(var(--safe-area-top)_+_0.25rem)]",
    );
    expect(FORM_SHEET_FOOTER_CLASS).toContain("pb-[calc(1rem_+_var(--safe-area-bottom))]");
  });
});

describe("focusFirstInvalid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the collapsed section holding the first invalid field and focuses it", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 0;
    });
    const details = { open: false };
    const target = {
      closest: vi.fn(() => details),
      focus: vi.fn(),
      scrollIntoView: vi.fn(),
    };
    const root = { querySelector: vi.fn(() => target) } as unknown as HTMLElement;

    focusFirstInvalid(root);

    expect(root.querySelector).toHaveBeenCalledWith('[aria-invalid="true"]');
    expect(details.open).toBe(true);
    expect(target.focus).toHaveBeenCalled();
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
  });

  it("does nothing when every field is valid", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 0;
    });
    const root = { querySelector: vi.fn(() => null) } as unknown as HTMLElement;
    expect(() => focusFirstInvalid(root)).not.toThrow();
  });
});
