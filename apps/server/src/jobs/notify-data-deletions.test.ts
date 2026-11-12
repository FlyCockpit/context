import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  list: vi.fn(),
  mark: vi.fn(),
  send: vi.fn(),
  configured: vi.fn(),
}));
vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-context/db/data-deletion-notices", () => ({
  listUnnotifiedDataDeletions: state.list,
  markDataDeletionNotified: state.mark,
}));
vi.mock("@cockpit-context/mailer", () => ({ isEmailConfigured: state.configured }));
vi.mock("./operational-alerts.js", () => ({ sendDataDeletedAlert: state.send }));

const {
  notifyDataDeletions,
  notifyDataDeletionsHandler,
  notifyDataDeletionsJob,
  NOTIFY_DATA_DELETIONS_SCHEDULE,
} = await import("./notify-data-deletions.js");
const notice = {
  name: "20260101_remove",
  effects: "unused data",
  deletedAt: new Date("2026-01-01Z"),
  backup: "backup.dump",
  note: null,
};
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.resetAllMocks();
  state.configured.mockReturnValue(true);
  state.list.mockResolvedValue([notice]);
  state.send.mockResolvedValue(1);
  state.mark.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("notifyDataDeletions", () => {
  it("reads, delivers, then marks only after a successful delivery", async () => {
    await expect(notifyDataDeletions(signal())).resolves.toEqual({ notified: 1, retried: 0 });
    expect(state.send).toHaveBeenCalledWith(notice);
    expect(state.mark).toHaveBeenCalledWith(notice.name);
    expect(state.list.mock.invocationCallOrder[0]).toBeLessThan(
      state.send.mock.invocationCallOrder[0]!,
    );
    expect(state.send.mock.invocationCallOrder[0]).toBeLessThan(
      state.mark.mock.invocationCallOrder[0]!,
    );
  });

  it.each([0, "reject"])("leaves the notice unmarked when delivery is %s", async (result) => {
    if (result === "reject") state.send.mockRejectedValueOnce(new Error("SMTP down"));
    else state.send.mockResolvedValueOnce(result);
    await expect(notifyDataDeletions(signal())).resolves.toEqual({ notified: 0, retried: 1 });
    expect(state.mark).not.toHaveBeenCalled();
    await expect(notifyDataDeletions(signal())).resolves.toEqual({ notified: 1, retried: 0 });
  });

  it("continues after a notice fails, and retries failed recording next run", async () => {
    state.list.mockResolvedValueOnce([notice, { ...notice, name: "20260202_remove" }]);
    state.mark.mockRejectedValueOnce(new Error("DB down"));
    await expect(notifyDataDeletions(signal())).resolves.toEqual({ notified: 1, retried: 1 });
    expect(state.send).toHaveBeenCalledTimes(2);
    await expect(notifyDataDeletions(signal())).resolves.toEqual({ notified: 1, retried: 0 });
  });

  it("does not read without SMTP or after cancellation", async () => {
    state.configured.mockReturnValue(false);
    await expect(notifyDataDeletions(signal())).resolves.toEqual({ notified: 0, retried: 0 });
    state.configured.mockReturnValue(true);
    const controller = new AbortController();
    controller.abort();
    await notifyDataDeletions(controller.signal);
    expect(state.list).not.toHaveBeenCalled();
  });

  it("stops before the next notice when shutdown aborts the handler", async () => {
    const controller = new AbortController();
    state.list.mockResolvedValue([notice, { ...notice, name: "later" }]);
    state.send.mockImplementation(async () => {
      controller.abort();
      return 1;
    });
    await expect(notifyDataDeletions(controller.signal)).resolves.toEqual({
      notified: 1,
      retried: 0,
    });
    expect(state.send).toHaveBeenCalledOnce();
  });

  it("serializes overlapping slots before reading their notices", async () => {
    let finish: (() => void) | undefined;
    state.send.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(1);
        }),
    );
    const first = notifyDataDeletions(signal());
    await vi.waitFor(() => expect(state.send).toHaveBeenCalledOnce());
    state.list.mockResolvedValue([]);
    const second = notifyDataDeletions(signal());
    await Promise.resolve();
    expect(state.list).toHaveBeenCalledOnce();
    finish?.();
    await first;
    await expect(second).resolves.toEqual({ notified: 0, retried: 0 });
    expect(state.mark).toHaveBeenCalledOnce();
  });

  it("a failed read does not poison the serialized queue", async () => {
    state.list.mockRejectedValueOnce(new Error("DB down"));
    await expect(notifyDataDeletions(signal())).rejects.toThrow("DB down");
    await expect(notifyDataDeletions(signal())).resolves.toEqual({ notified: 1, retried: 0 });
  });

  it("registers a single-attempt periodic handler", async () => {
    expect(NOTIFY_DATA_DELETIONS_SCHEDULE.everyMs).toBe(15 * 60_000);
    expect(notifyDataDeletionsJob.payload.safeParse({ reason: "other" }).success).toBe(false);
    await notifyDataDeletionsHandler.handler({
      id: "job",
      type: notifyDataDeletionsJob.type,
      payload: { reason: "schedule" },
      attempt: 1,
      maxAttempts: 1,
      signal: signal(),
    });
    expect(state.mark).toHaveBeenCalledOnce();
  });
});
