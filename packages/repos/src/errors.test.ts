import { describe, expect, it } from "vitest";

import {
  INTERRUPTED_BY_RESTART,
  lastErrorText,
  MAX_LAST_ERROR_LENGTH,
  RepoError,
  repositoryFailureReason,
} from "./errors";

describe("lastErrorText", () => {
  it("leads a RepoError with its code, and keeps any other error's message", () => {
    expect(lastErrorText(new RepoError("GIT_FAILED", "git clone failed: boom"))).toBe(
      "GIT_FAILED: git clone failed: boom",
    );
    expect(lastErrorText(new Error("connect refused"))).toBe("connect refused");
    expect(lastErrorText("plain")).toBe("plain");
  });

  it("caps the stored text", () => {
    const text = lastErrorText(new Error("x".repeat(MAX_LAST_ERROR_LENGTH + 10)));
    expect(text).toHaveLength(MAX_LAST_ERROR_LENGTH + 1);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("repositoryFailureReason", () => {
  const stored = (error: unknown) => repositoryFailureReason(lastErrorText(error));

  it("maps a stored RepoError code to its reason", () => {
    expect(stored(new RepoError("HOST_KEY_UNCONFIRMED", "No confirmed host key"))).toBe("hostKey");
    expect(stored(new RepoError("PRIVATE_ADDRESS", "Refusing to connect"))).toBe("privateAddress");
    expect(stored(new RepoError("INVALID_REMOTE_URL", "bad"))).toBe("invalidUrl");
    expect(stored(new RepoError("HOST_UNRESOLVABLE", "no dns"))).toBe("unreachable");
    expect(stored(new RepoError("SSH_KEY_UNREADABLE", "gcm"))).toBe("sshKey");
    expect(stored(new RepoError("GIT_TIMEOUT", "git clone timed out after 600s."))).toBe("timeout");
  });

  it("reads git's own output for a GIT_FAILED clone or fetch", () => {
    const git = (stderr: string) =>
      stored(new RepoError("GIT_FAILED", `git clone failed: ${stderr}`));
    expect(git("git@github.com: Permission denied (publickey).")).toBe("auth");
    expect(
      git("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    ).toBe("auth");
    expect(git("remote: Repository not found.\nfatal: repository '…' not found")).toBe("notFound");
    expect(git("fatal: unable to access '…': Could not resolve host: example.invalid")).toBe(
      "unreachable",
    );
    expect(git("Host key verification failed.")).toBe("hostKey");
    expect(git("fatal: early EOF")).toBe("other");
  });

  it("knows a restart, a snapshot and rows written before the code prefix", () => {
    expect(repositoryFailureReason(INTERRUPTED_BY_RESTART)).toBe("interrupted");
    expect(repositoryFailureReason("Snapshot operation failed.")).toBe("snapshot");
    expect(repositoryFailureReason("git fetch failed: remote: Repository not found.")).toBe(
      "notFound",
    );
    expect(repositoryFailureReason("git fetch timed out after 120s.")).toBe("timeout");
    expect(repositoryFailureReason(null)).toBe("other");
    expect(repositoryFailureReason("something else")).toBe("other");
  });
});
