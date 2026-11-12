import { RepoError } from "@cockpit-context/repos/errors";
import { RunEngineError } from "@cockpit-context/runs/errors";
import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";

import { domainErrorToOrpc, withDomainErrors } from "./domain-errors";

describe("domainErrorToOrpc", () => {
  it("maps a git-layer error to a fixed message and an allowlisted reason", () => {
    const error = domainErrorToOrpc(
      new RepoError("GIT_FAILED", "fatal: could not read from /data/repos/abc.git (stderr)"),
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error?.code).toBe("BAD_GATEWAY");
    expect(error?.data).toEqual({ reason: "GIT_FAILED" });
    expect(error?.message).not.toContain("/data/repos");
    expect(error?.toJSON()).not.toHaveProperty("cause");
  });

  it("maps the queued-run cap (BUSY) to 429 with its reason, not a 503 a proxy may retry", () => {
    const error = domainErrorToOrpc(new RunEngineError("BUSY", "busy"));
    expect(error?.code).toBe("TOO_MANY_REQUESTS");
    expect(error?.status).toBe(429);
    expect(error?.data).toEqual({ reason: "BUSY" });
  });

  it("carries the host to confirm and the nearest tags, and nothing else", () => {
    expect(
      domainErrorToOrpc(
        new RepoError("HOST_KEY_UNCONFIRMED", "confirm", { host: "git.example.com", port: 2222 }),
      )?.data,
    ).toEqual({ reason: "HOST_KEY_UNCONFIRMED", host: "git.example.com", port: 2222 });
    const tags = Array.from({ length: 15 }, (_, index) => `v1.${index}.0`);
    const data = domainErrorToOrpc(
      new RepoError("VERSION_NOT_FOUND", "none", { nearestTags: tags }),
    )?.data;
    expect(data?.nearestTags).toHaveLength(10);
  });

  it("maps run-engine errors", () => {
    const error = domainErrorToOrpc(new RunEngineError("CONVERSATION_NOT_FOUND", "x"));
    expect(error?.code).toBe("NOT_FOUND");
    expect(error?.data).toEqual({ reason: "CONVERSATION_NOT_FOUND" });
  });

  it("leaves other errors alone", async () => {
    expect(domainErrorToOrpc(new Error("boom"))).toBeNull();
    const original = new Error("boom");
    await expect(
      withDomainErrors(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});
