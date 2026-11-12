import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: { DATABASE_URL: "postgresql://u:p@db:5432/app" },
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));
vi.mock("@cockpit-context/env/shared", () => ({ env: state.env }));
vi.mock("./index", () => ({
  default: { $queryRaw: state.queryRaw, $executeRaw: state.executeRaw },
}));
vi.mock("../prisma/generated/client", () => ({
  Prisma: { raw: (sql: string) => ({ raw: sql }) },
}));

const {
  listUnnotifiedDataDeletions,
  markDataDeletionNotified,
  DATA_DELETION_NOTICE_LIMIT,
  DATA_DELETION_NOTICE_WINDOW_DAYS,
} = await import("./data-deletion-notices");

/** The SQL text (`?` per value) and values of the nth call of a raw mock. */
function call(mock: typeof state.queryRaw, n: number) {
  const [strings, ...values] = mock.mock.calls[n] ?? [];
  return { sql: (strings as string[]).join("?"), values };
}

beforeEach(() => {
  state.queryRaw.mockReset();
  state.executeRaw.mockReset();
  state.env.DATABASE_URL = "postgresql://u:p@db:5432/app";
});

describe("listUnnotifiedDataDeletions", () => {
  it("is a silent no-op when the runner's table or column does not exist", async () => {
    state.queryRaw.mockResolvedValueOnce([{ present: false }]);

    await expect(listUnnotifiedDataDeletions()).resolves.toEqual([]);

    expect(state.queryRaw).toHaveBeenCalledTimes(1);
    const probe = call(state.queryRaw, 0);
    expect(probe.sql).toContain("information_schema.columns");
    expect(probe.sql).toContain("'contract_notified_at'");
    expect(probe.values).toEqual(["public"]);
  });

  it("looks in the schema the runner uses (DATABASE_URL ?schema=)", async () => {
    state.env.DATABASE_URL = "postgresql://u:p@db:5432/app?schema=tenant_a";
    state.queryRaw.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([]);

    await listUnnotifiedDataDeletions();

    expect(call(state.queryRaw, 0).values).toEqual(["tenant_a"]);
    expect(call(state.queryRaw, 1).values[0]).toEqual({
      raw: '"tenant_a"."_cockpit_context_migration"',
    });
  });

  // Reading must not mark: a crash before the send would otherwise lose the
  // notice. Marking is a separate call made only after an email went out.
  it("reads a bounded batch of recent, unnotified rows without marking them", async () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const deletedAt = new Date("2026-11-01T10:00:00Z");
    state.queryRaw.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([
      {
        name: "20261010000000_drop_a",
        contract_effects: "column a.x",
        contract_applied_at: deletedAt,
        contract_backup: "pre-migrate-2026-11-01",
        contract_note: "enum rebuilt",
      },
    ]);

    const notices = await listUnnotifiedDataDeletions(DATA_DELETION_NOTICE_LIMIT, now);

    const read = call(state.queryRaw, 1);
    expect(read.sql).toMatch(/^\s*SELECT /);
    expect(read.sql).not.toContain("UPDATE");
    expect(read.sql).toContain("contract_applied_at >= ? AND contract_notified_at IS NULL");
    expect(read.sql).toContain("ORDER BY contract_applied_at, name");
    expect(read.sql).toMatch(/LIMIT \?/);
    expect(read.values).toContain(DATA_DELETION_NOTICE_LIMIT);
    expect(state.executeRaw).not.toHaveBeenCalled();
    expect(notices).toEqual([
      {
        name: "20261010000000_drop_a",
        effects: "column a.x",
        deletedAt,
        backup: "pre-migrate-2026-11-01",
        note: "enum rebuilt",
      },
    ]);
  });

  // Rows deleted before this feature existed were never marked; announcing
  // them all at once on first run would flood every admin.
  it("ignores deletions older than the notice window", async () => {
    const now = new Date("2026-11-11T12:00:00Z");
    state.queryRaw.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([]);

    await listUnnotifiedDataDeletions(DATA_DELETION_NOTICE_LIMIT, now);

    expect(DATA_DELETION_NOTICE_WINDOW_DAYS).toBe(14);
    expect(call(state.queryRaw, 1).values).toContainEqual(new Date("2026-10-28T12:00:00Z"));
  });
});

describe("markDataDeletionNotified", () => {
  it("marks that one row, only if nobody marked it already", async () => {
    state.executeRaw.mockResolvedValueOnce(1);

    await markDataDeletionNotified("20261010000000_drop_a");

    const mark = call(state.executeRaw, 0);
    expect(mark.sql).toContain(
      "SET contract_notified_at = now()\n     WHERE name = ? AND contract_notified_at IS NULL",
    );
    expect(mark.values).toEqual([
      { raw: '"public"."_cockpit_context_migration"' },
      "20261010000000_drop_a",
    ]);
  });
});
