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
  it("passes the message, duration and action through", () => {
    const onClick = vi.fn();
    toast.error("Failed", { duration: 5000, action: { label: "Retry", onClick } });
    expect(backend.error).toHaveBeenCalledWith({
      id: expect.any(String),
      title: "Failed",
      duration: 5000,
      button: { title: "Retry", onClick },
    });
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
});
