import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import { findOwnedOrThrow } from "./ownership";

describe("findOwnedOrThrow", () => {
  it("merges the owner clause into the query and returns the row", async () => {
    const find = vi.fn().mockResolvedValue({ id: "1" });

    await expect(
      findOwnedOrThrow({
        find,
        args: { where: { id: "1" }, select: { id: true } },
        owner: { field: "userId", id: "user-1" },
        notFound: "missing",
      }),
    ).resolves.toEqual({ id: "1" });

    expect(find).toHaveBeenCalledWith({
      where: { AND: [{ id: "1" }, { userId: "user-1" }] },
      select: { id: true },
    });
  });

  it("cannot have its owner clause overwritten by the caller's where", async () => {
    const find = vi.fn().mockResolvedValue(null);

    await findOwnedOrThrow({
      find,
      // A caller who tries to widen the scope only adds a second AND term.
      args: { where: { id: "1", userId: "someone-else", OR: [{ userId: "anyone" }] } },
      owner: { field: "userId", id: "user-1" },
      notFound: "missing",
    }).catch(() => {});

    expect(find).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: "1", userId: "someone-else", OR: [{ userId: "anyone" }] },
          { userId: "user-1" },
        ],
      },
    });
  });

  it("throws NOT_FOUND when the scoped lookup missed", async () => {
    const error = await findOwnedOrThrow({
      find: () => Promise.resolve(null),
      args: { where: { id: "1" } },
      owner: { field: "userId", id: "user-1" },
      notFound: "Subscription not found",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
    expect((error as ORPCError<string, unknown>).message).toBe("Subscription not found");
  });
});
