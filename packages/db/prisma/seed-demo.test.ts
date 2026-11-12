import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";

import type prismaClient from "../src/index";

const db = mockDeep<typeof prismaClient>();
vi.mock("../src/index", () => ({ default: db }));

const { foldToolResults, seedDemoData, DEMO_PACKAGES, DEMO_TOKEN_NAME } = await import(
  "./seed-demo"
);

const SECRET = "s".repeat(32);
const OWNER = "owner-1";

type Row = Record<string, unknown>;

/** Fresh database: every lookup misses, every create returns an id. */
function emptyDatabase() {
  let next = 0;
  const id = () => ({ id: `id-${++next}` });
  db.package.findUnique.mockResolvedValue(null);
  db.package.create.mockImplementation((() => Promise.resolve(id())) as never);
  db.repository.findUnique.mockResolvedValue(null);
  db.repository.create.mockImplementation((() => Promise.resolve(id())) as never);
  db.checkout.findUnique.mockResolvedValue(null);
  db.checkout.create.mockImplementation((() => Promise.resolve(id())) as never);
  db.mcpAgentToken.findFirst.mockResolvedValue(null);
  db.mcpAgentToken.create.mockImplementation((() => Promise.resolve(id())) as never);
  db.packageProposal.findFirst.mockResolvedValue(null);
  db.packageProposal.create.mockImplementation((() => Promise.resolve(id())) as never);
  db.conversation.findFirst.mockResolvedValue(null);
  db.conversation.create.mockImplementation((() => Promise.resolve(id())) as never);
  db.agentRun.create.mockImplementation((() => Promise.resolve(id())) as never);
  db.$transaction.mockImplementation(((fn: (tx: typeof db) => Promise<unknown>) =>
    fn(db)) as never);
}

/** Every natural key already exists. */
function seededDatabase() {
  db.package.findUnique.mockResolvedValue({ id: "pkg" } as never);
  db.repository.findUnique.mockResolvedValue({ id: "repo" } as never);
  db.checkout.findUnique.mockResolvedValue({ id: "co" } as never);
  db.mcpAgentToken.findFirst.mockResolvedValue({ id: "tok" } as never);
  db.packageProposal.findFirst.mockResolvedValue({ id: "prop" } as never);
  db.conversation.findFirst.mockResolvedValue({ id: "conv" } as never);
}

const createArgs = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.map((call) => (call[0] as { data: Row }).data);

describe("seedDemoData", () => {
  beforeEach(() => {
    mockReset(db);
  });

  it("creates packages, repositories, checkouts, a token, proposals and conversations for one owner", async () => {
    emptyDatabase();
    const reveal = vi.fn();

    const summary = await seedDemoData({
      ownerId: OWNER,
      betterAuthSecret: SECRET,
      revealSecret: reveal,
    });

    expect(db.package.create).toHaveBeenCalledTimes(DEMO_PACKAGES.length);
    expect(createArgs(db.package.create).every((data) => data.ownerId === OWNER)).toBe(true);
    expect(db.repository.create).toHaveBeenCalledTimes(3);
    expect(createArgs(db.repository.create).every((data) => data.visibility === "PUBLIC")).toBe(
      true,
    );
    expect(db.checkout.create).toHaveBeenCalledTimes(2);
    expect(db.packageProposal.create).toHaveBeenCalledTimes(2);
    expect(
      createArgs(db.packageProposal.create)
        .map((data) => data.status)
        .sort(),
    ).toEqual(["APPROVED", "PENDING"]);
    expect(db.conversation.create).toHaveBeenCalledTimes(4);
    expect(createArgs(db.conversation.create).every((data) => data.ownerId === OWNER)).toBe(true);
    expect(summary.length).toBeGreaterThan(0);

    // The token: stored as prefix + digest; the plaintext only reaches revealSecret, once.
    const token = createArgs(db.mcpAgentToken.create)[0];
    expect(token).toMatchObject({ userId: OWNER, name: DEMO_TOKEN_NAME });
    expect(token?.secretDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(reveal).toHaveBeenCalledOnce();
    const plaintext = /(cockpit_context_\S+)/.exec(String(reveal.mock.calls[0]?.[0]))?.[1] ?? "";
    expect(plaintext.startsWith(String(token?.lookupPrefix))).toBe(true);
    expect(JSON.stringify(token)).not.toContain(plaintext);
    expect(summary.join("\n")).not.toContain(plaintext);
  });

  it("writes runs with helper children and turns in order, including a steering turn", async () => {
    emptyDatabase();
    await seedDemoData({ ownerId: OWNER, betterAuthSecret: SECRET });

    const runs = createArgs(db.agentRun.create);
    expect(runs.every((run) => run.ownerId === OWNER)).toBe(true);
    const helpers = runs.filter((run) => run.kind === "HELPER");
    expect(helpers).toHaveLength(2);
    expect(helpers.every((run) => typeof run.parentRunId === "string" && run.focus)).toBe(true);
    expect(runs.map((run) => run.status)).toEqual(
      expect.arrayContaining(["COMPLETED", "STOPPED", "INTERRUPTED"]),
    );
    expect(runs.every((run) => Number.isInteger(run.costUsdMicros))).toBe(true);

    const turns = db.runTurn.createMany.mock.calls.flatMap(
      (call) => (call[0] as { data: Row[] }).data,
    );
    expect(turns.some((turn) => turn.steering === true && turn.role === "USER")).toBe(true);
    // The engine saves tool results inside the assistant turn; no TOOL rows.
    expect(turns.every((turn) => turn.role === "USER" || turn.role === "ASSISTANT")).toBe(true);
    for (const call of db.runTurn.createMany.mock.calls) {
      const rows = (call[0] as { data: Row[] }).data;
      expect(rows.map((row) => row.seq)).toEqual(rows.map((_, index) => index));
    }
  });

  it("is idempotent: a second run over seeded data creates nothing and reveals no secret", async () => {
    seededDatabase();
    const reveal = vi.fn();

    await seedDemoData({ ownerId: OWNER, betterAuthSecret: SECRET, revealSecret: reveal });

    expect(db.package.create).not.toHaveBeenCalled();
    expect(db.repository.create).not.toHaveBeenCalled();
    expect(db.checkout.create).not.toHaveBeenCalled();
    expect(db.mcpAgentToken.create).not.toHaveBeenCalled();
    expect(db.packageProposal.create).not.toHaveBeenCalled();
    expect(db.conversation.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("only links a package to its repository when the package has none yet", async () => {
    emptyDatabase();
    await seedDemoData({ ownerId: OWNER, betterAuthSecret: SECRET });
    for (const call of db.package.updateMany.mock.calls) {
      expect(call[0]?.where).toMatchObject({ ownerId: OWNER, repositoryId: null });
    }
  });
});

describe("foldToolResults", () => {
  it("moves tool results into the assistant turn before them and sets each call's output", () => {
    const folded = foldToolResults([
      { role: "USER", parts: [{ type: "text", content: "q" }] },
      {
        role: "ASSISTANT",
        parts: [{ type: "tool-call", id: "c1", name: "glob", state: "complete" }],
      },
      {
        role: "TOOL",
        parts: [{ type: "tool-result", toolCallId: "c1", content: "out", state: "complete" }],
      },
      { role: "ASSISTANT", parts: [{ type: "text", content: "answer" }] },
    ]);
    expect(folded.map((turn) => turn.role)).toEqual(["USER", "ASSISTANT", "ASSISTANT"]);
    expect(folded[1]?.parts).toEqual([
      { type: "tool-call", id: "c1", name: "glob", state: "complete", output: "out" },
      { type: "tool-result", toolCallId: "c1", content: "out", state: "complete" },
    ]);
  });
});
