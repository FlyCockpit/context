import { describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(() => "toast-1"), dismiss: vi.fn() }));
vi.mock("@cockpit-context/ui/components/sileo", () => ({ toast }));

const { ARCHIVE_UNDO_TOAST_MS, announceArchivedWithUndo } = await import("./archive-undo");

describe("announceArchivedWithUndo", () => {
  it("shows a success toast whose Undo restores the user once and dismisses the toast", () => {
    toast.success.mockClear();
    toast.dismiss.mockClear();
    const onUndo = vi.fn();
    const id = announceArchivedWithUndo({ message: "User archived", undoLabel: "Undo", onUndo });

    expect(id).toBe("toast-1");
    expect(toast.success).toHaveBeenCalledWith("User archived", {
      duration: ARCHIVE_UNDO_TOAST_MS,
      action: { label: "Undo", onClick: expect.any(Function) },
    });
    expect(onUndo).not.toHaveBeenCalled();
    const options = (toast.success.mock.calls[0] as unknown[])[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    options.action.onClick();
    expect(onUndo).toHaveBeenCalledOnce();
    expect(toast.dismiss).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).toHaveBeenCalledWith("toast-1");
  });

  it("stays up longer than a plain toast so the Undo can be reached", () => {
    expect(ARCHIVE_UNDO_TOAST_MS).toBeGreaterThanOrEqual(6_000);
  });
});
