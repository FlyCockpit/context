import { describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-context/repos", () => ({
  isRepoError: (error: unknown) =>
    error instanceof Error && "code" in error && error.name === "RepoError",
}));

const { runFailureFrom, runFailureFromJson } = await import("./failure");

const repoError = (code: string, details: Record<string, unknown>) =>
  Object.assign(new Error("git said: fatal at /data/repos/x.git"), {
    name: "RepoError",
    code,
    details,
  });

describe("runFailureFrom", () => {
  it("keeps the code and only the allowlisted details", () => {
    expect(
      runFailureFrom(
        repoError("VERSION_NOT_FOUND", {
          nearestTags: Array.from({ length: 12 }, (_, i) => `v1.${i}`),
          reason: "x",
        }),
      ),
    ).toEqual({
      reason: "VERSION_NOT_FOUND",
      nearestTags: Array.from({ length: 10 }, (_, i) => `v1.${i}`),
    });
    expect(runFailureFrom(repoError("GIT_FAILED", { host: "h", port: 22 }))).toEqual({
      reason: "GIT_FAILED",
    });
    expect(runFailureFrom(repoError("HOST_KEY_UNCONFIRMED", { host: "h", port: 22 }))).toEqual({
      reason: "HOST_KEY_UNCONFIRMED",
      host: "h",
      port: 22,
    });
  });

  it("has no detail for anything but a RepoError", () => {
    expect(runFailureFrom(new Error("ECONNRESET"))).toBeNull();
    expect(runFailureFrom("x")).toBeNull();
  });
});

describe("runFailureFromJson", () => {
  it("reads back a stored failure", () => {
    const stored = { reason: "VERSION_NOT_FOUND", nearestTags: ["v1"], host: "h", port: 2222 };
    expect(runFailureFromJson(stored)).toEqual(stored);
  });

  it("drops anything that is not the expected shape", () => {
    expect(runFailureFromJson(null)).toBeNull();
    expect(runFailureFromJson([])).toBeNull();
    expect(runFailureFromJson({ reason: "fatal: /data/repos/x" })).toBeNull();
    expect(
      runFailureFromJson({
        reason: "REF_NOT_FOUND",
        nearestTags: ["ok", 7, "x".repeat(300)],
        port: 1.5,
        stderr: "secret",
      }),
    ).toEqual({ reason: "REF_NOT_FOUND", nearestTags: ["ok"] });
  });
});
