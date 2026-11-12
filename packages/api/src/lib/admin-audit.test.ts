import { afterEach, expect, it, vi } from "vitest";

import { recordAdminAudit } from "./admin-audit";

afterEach(() => {
  vi.restoreAllMocks();
});

it("writes one structured [audit] line naming actor, target, action and time", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  recordAdminAudit(
    {
      action: "users.passwordLink",
      actorUserId: "admin-1",
      targetUserId: "user-2",
      details: { delivery: "admin", expiresAt: "2026-11-19T00:00:00.000Z" },
    },
    new Date("2026-11-12T00:00:00.000Z"),
  );
  expect(warn).toHaveBeenCalledOnce();
  const line = String(warn.mock.calls[0]?.[0]);
  expect(line.startsWith("[audit] ")).toBe(true);
  expect(JSON.parse(line.slice("[audit] ".length))).toEqual({
    audit: "admin",
    action: "users.passwordLink",
    actorUserId: "admin-1",
    targetUserId: "user-2",
    at: "2026-11-12T00:00:00.000Z",
    details: { delivery: "admin", expiresAt: "2026-11-19T00:00:00.000Z" },
  });
});
