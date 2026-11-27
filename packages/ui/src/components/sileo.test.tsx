import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  show: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("sileo", () => ({ sileo: backend, Toaster: () => null }));
vi.mock("sileo/styles.css", () => ({}));

import { toast } from "./sileo";

beforeEach(() => {
  for (const fn of Object.values(backend)) fn.mockReset();
});

describe("toast facade", () => {
  it("passes the message, duration and renders action inside description", () => {
    const onClick = vi.fn();
    toast.error("Failed", { duration: 5000, action: { label: "Retry", onClick } });
    expect(backend.error).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        title: "Failed",
        duration: 5000,
        description: expect.anything(),
      }),
    );
    expect(backend.error.mock.calls[0]?.[0]).not.toHaveProperty("button");
  });

  it("gives every toast its own id so two toasts stack instead of merging", () => {
    // sileo defaults every toast to id "sileo-default" and replaces in place.
    const first = toast.error("That wasn't found.");
    const second = toast.error("That wasn't found.");

    expect(first).not.toBe(second);
    expect(backend.error.mock.calls.map(([options]) => options.id)).toEqual([first, second]);
  });

  it("repeats a long message in the description so the clipped pill loses nothing", () => {
    const long = "That code didn't work. Check your authenticator and try again.";
    toast.error(long);
    toast.success("Saved");

    expect(backend.error).toHaveBeenCalledWith(
      expect.objectContaining({ title: long, description: long }),
    );
    expect(backend.success.mock.calls[0]?.[0]).not.toHaveProperty("description");
  });

  it("decides by the measured width, not the character count", async () => {
    const { titleOverflowsPill, pillTitleBudget } = await import("./sileo");
    // ~8px per glyph at a 16px root: 36 characters fit, 36 wide glyphs don't.
    const at16 = (perChar: number) => (m: string) => ({
      width: m.length * perChar,
      budget: pillTitleBudget(16),
    });
    expect(pillTitleBudget(16)).toBe(292);
    expect(titleOverflowsPill("a".repeat(36), at16(6.5))).toBe(false);
    expect(titleOverflowsPill("W".repeat(30), at16(11))).toBe(true);
    // At a 24px root (a larger text size) the font grows but sileo's pill does
    // not: a 36-character message that fit at 16px no longer does.
    const at24 = (m: string) => ({ width: m.length * 6.5 * 1.5, budget: pillTitleBudget(24) });
    expect(titleOverflowsPill("We've emailed you a verification code", at24)).toBe(true);
  });

  it("falls back to a length rule when nothing can be measured", async () => {
    const { titleOverflowsPill } = await import("./sileo");
    expect(titleOverflowsPill("Saved", () => null)).toBe(false);
    expect(titleOverflowsPill("x".repeat(41), () => null)).toBe(true);
  });
});
