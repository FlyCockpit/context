import { describe, expect, it } from "vitest";

import {
  buildPackageFormSchema,
  describeResolvedFrom,
  emptyPackageForm,
  formatBytes,
  hasUpdates,
  isSshRemote,
  type PackageFormValues,
  toApproveInput,
  toCreateInput,
  toUpdateInput,
} from "./packages";

const MESSAGES = {
  sshKeyRequired: "key",
  privateKeyRequired: "private-key",
  keyNameRequired: "key-name",
  subdirectory: "subdir",
  tagPattern: "tag",
};

function form(overrides: Partial<PackageFormValues> = {}): PackageFormValues {
  return {
    ...emptyPackageForm(),
    name: "zod",
    gitUrl: "https://github.com/colinhacks/zod",
    ...overrides,
  };
}

function issues(values: PackageFormValues) {
  const result = buildPackageFormSchema(MESSAGES).safeParse(values);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("isSshRemote", () => {
  it("recognizes ssh:// and scp-like remotes", () => {
    expect(isSshRemote("ssh://git@github.com/o/r")).toBe(true);
    expect(isSshRemote("SSH://git@host:2222/o/r")).toBe(true);
    expect(isSshRemote("git@github.com:o/r.git")).toBe(true);
    expect(isSshRemote("  git@gitlab.example.com:group/r  ")).toBe(true);
  });

  it("treats https, other schemes and partial input as not SSH", () => {
    expect(isSshRemote("https://github.com/o/r")).toBe(false);
    expect(isSshRemote("https://user@github.com:443/o/r")).toBe(false);
    expect(isSshRemote("file:///etc")).toBe(false);
    expect(isSshRemote("git@github.com")).toBe(false);
    expect(isSshRemote("")).toBe(false);
  });
});

describe("describeResolvedFrom", () => {
  const sha = "0123456789abcdef";
  it("splits tags and branches and shortens commits", () => {
    expect(describeResolvedFrom("tag:v5.0.0", sha)).toEqual({ kind: "tag", label: "v5.0.0" });
    expect(describeResolvedFrom("branch:main", sha)).toEqual({ kind: "branch", label: "main" });
    expect(describeResolvedFrom("commit", sha)).toEqual({ kind: "commit", label: "0123456" });
    expect(describeResolvedFrom(null, sha)).toEqual({ kind: "commit", label: "0123456" });
    expect(describeResolvedFrom("npm-gitHead", sha)).toEqual({
      kind: "npmGitHead",
      label: "0123456",
    });
  });
});

describe("formatBytes", () => {
  it("uses decimal units with one fraction digit below 100", () => {
    expect(formatBytes(0, "en-US")).toBe("0 kB");
    expect(formatBytes(400, "en-US")).toBe("0.4 kB");
    expect(formatBytes(1_536, "en-US")).toBe("1.5 kB");
    expect(formatBytes(250_000_000, "en-US")).toBe("250 MB");
    expect(formatBytes(3_200_000_000, "en-US")).toBe("3.2 GB");
  });
});

describe("toCreateInput / toApproveInput", () => {
  it("trims, turns blanks into null and drops a blank display name", () => {
    expect(
      toCreateInput(form({ name: " zod ", subdirectory: "  ", notes: " Use v4 APIs " })),
    ).toEqual({
      ecosystem: "npm",
      name: "zod",
      displayName: undefined,
      gitUrl: "https://github.com/colinhacks/zod",
      sshKeyId: null,
      subdirectory: null,
      tagPattern: null,
      defaultRef: null,
      notes: "Use v4 APIs",
    });
  });

  it("sends the SSH key only with an SSH remote", () => {
    expect(toCreateInput(form({ sshKeyId: "key_1" })).sshKeyId).toBeNull();
    expect(
      toApproveInput("p1", form({ gitUrl: "git@github.com:o/r", sshKeyId: "key_1" })),
    ).toMatchObject({ id: "p1", gitUrl: "git@github.com:o/r", sshKeyId: "key_1" });
  });
});

describe("toUpdateInput", () => {
  const before = form({ displayName: "Zod", notes: "old", tagPattern: "zod@{version}" });

  it("sends only what changed, with null to clear", () => {
    const input = toUpdateInput("p1", before, { ...before, notes: "", displayName: "Zod 4" });
    expect(input).toEqual({ id: "p1", displayName: "Zod 4", notes: null });
    expect(hasUpdates(input)).toBe(true);
  });

  it("leaves the git URL out unless the remote or key changed", () => {
    expect(
      hasUpdates(toUpdateInput("p1", before, { ...before, gitUrl: " " + before.gitUrl })),
    ).toBe(false);
    expect(
      toUpdateInput("p1", before, { ...before, gitUrl: "git@github.com:o/r", sshKeyId: "k" }),
    ).toEqual({ id: "p1", gitUrl: "git@github.com:o/r", sshKeyId: "k" });
  });

  it("never clears the display name", () => {
    expect(toUpdateInput("p1", before, { ...before, displayName: "" })).toEqual({ id: "p1" });
  });
});

describe("buildPackageFormSchema", () => {
  it("accepts a plain HTTPS package", () => {
    expect(issues(form())).toEqual([]);
  });

  it("requires a key for an SSH remote", () => {
    expect(issues(form({ gitUrl: "git@github.com:o/r" }))).toEqual(["sshKeyId"]);
    expect(issues(form({ gitUrl: "git@github.com:o/r", sshKeyId: "k" }))).toEqual([]);
  });

  it("rejects escaping subdirectories and tag patterns without {version}", () => {
    expect(issues(form({ subdirectory: "../etc" }))).toEqual(["subdirectory"]);
    expect(issues(form({ subdirectory: "/abs" }))).toEqual(["subdirectory"]);
    expect(issues(form({ subdirectory: "packages/react-query/" }))).toEqual([]);
    expect(issues(form({ tagPattern: "v1.0.0" }))).toEqual(["tagPattern"]);
    expect(issues(form({ tagPattern: "v{version}" }))).toEqual([]);
  });

  it("needs a name and a git URL", () => {
    expect(issues(form({ name: " ", gitUrl: "" }))).toEqual(["name", "gitUrl"]);
  });
});

it("sends pasted credentials only for one-time SSH use and defaults saving off", () => {
  const value = form({
    gitUrl: "git@example.com:o/r",
    keyMode: "once",
    privateKey: "private",
    passphrase: "phrase",
  });
  expect(toCreateInput(value)).toMatchObject({
    sshKeyId: null,
    oneTimeKey: { privateKey: "private", passphrase: "phrase", save: false },
  });
  expect(toApproveInput("p1", value)).toHaveProperty("oneTimeKey");
  expect(toCreateInput({ ...value, keyMode: "saved", sshKeyId: "key" })).not.toHaveProperty(
    "oneTimeKey",
  );
  expect(toCreateInput({ ...value, gitUrl: "https://github.com/o/r" })).not.toHaveProperty(
    "oneTimeKey",
  );
  expect(issues(value)).toEqual([]);
  expect(issues({ ...value, saveKey: true })).toContain("keyName");
  expect(issues({ ...value, privateKey: "" })).toContain("privateKey");
});

it("asks for the pasted key or its name, not for a saved key, in one-time mode", () => {
  const value = form({ gitUrl: "git@example.com:o/r", keyMode: "once" });
  const messages = (values: PackageFormValues) => {
    const result = buildPackageFormSchema(MESSAGES).safeParse(values);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };
  expect(messages(value)).toEqual(["private-key"]);
  expect(messages({ ...value, privateKey: "private", saveKey: true })).toEqual(["key-name"]);
});

it("allows metadata edits on snapshots without a saved key", () => {
  expect(issues(form({ gitUrl: "git@example.com:o/r", isSnapshot: true }))).toEqual([]);
});

it("ignores hidden one-time key requirements after switching to HTTPS", () => {
  for (const saveKey of [false, true]) {
    const values = form({ keyMode: "once", saveKey, privateKey: "", keyName: "" });
    expect(issues(values)).toEqual([]);
    expect(toCreateInput(values)).not.toHaveProperty("oneTimeKey");
  }
});
