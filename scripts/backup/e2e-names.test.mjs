import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { containerPrefix, DEFAULT_CONTAINER_PREFIX, e2eNames } from "./e2e-names.mjs";

describe("backup e2e names", () => {
  it("takes TEST_CONTAINER_PREFIX when there is no flag; the flag wins", () => {
    assert.equal(containerPrefix([], { TEST_CONTAINER_PREFIX: "ci-env" }), "ci-env");
    assert.equal(
      containerPrefix(["--container-prefix", "ci-flag"], { TEST_CONTAINER_PREFIX: "ci-env" }),
      "ci-flag",
    );
    // Validated like the flag; an empty or invalid value is an error, not the default.
    for (const bad of ["", "Bad", "a-", "x".repeat(33)])
      assert.throws(
        () => containerPrefix([], { TEST_CONTAINER_PREFIX: bad }),
        /TEST_CONTAINER_PREFIX needs a Docker name prefix/,
      );
  });

  it("keeps the default prefix without the flag", () => {
    assert.equal(containerPrefix([], {}), "cockpit-context-backup-test");
    assert.equal(DEFAULT_CONTAINER_PREFIX, "cockpit-context-backup-test");
    assert.deepEqual(
      { ...e2eNames(containerPrefix([], {}), "1-a"), tool: undefined },
      {
        toolsImage: "cockpit-context-backup-test-tools:1-a",
        network: "cockpit-context-backup-test-net-1-a",
        pg: "cockpit-context-backup-test-pg-1-a",
        tool: undefined,
      },
    );
  });

  it("puts every container, the network and the tools image under the prefix", () => {
    const names = e2eNames(containerPrefix(["--container-prefix", "ci-run7"]), "9-z");
    const all = [names.toolsImage, names.network, names.pg, names.tool(1), names.tool(2)];
    for (const name of all) assert.ok(name.startsWith("ci-run7-"), name);
    assert.equal(names.toolsImage, "ci-run7-tools:9-z");
    assert.equal(new Set(all).size, all.length);
  });

  it("accepts the separators Docker image names allow", () => {
    for (const prefix of ["ci-run7", "a.b", "a_b", "a__b", "a--b", "x".repeat(32)])
      assert.equal(containerPrefix(["--container-prefix", prefix]), prefix);
  });

  it("keeps every container name a DNS label (<= 63) at the longest prefix and suffix", () => {
    // pid up to 7 digits (pid_max 4194304) and Date.now() in base 36 (8 chars).
    const suffix = `4194304-${(2 ** 41).toString(36)}`;
    const names = e2eNames(containerPrefix(["--container-prefix", "x".repeat(32)]), suffix);
    for (const name of Object.values(names).filter((value) => typeof value === "string"))
      if (!name.includes(":")) assert.ok(name.length <= 63, name);
    assert.ok(names.tool(999).length <= 63);
    assert.throws(() => e2eNames("x".repeat(32), "y".repeat(40)), /too long/);
  });

  it("refuses a missing or invalid prefix", () => {
    for (const argv of [
      ["--container-prefix"],
      ["--container-prefix", ""],
      ["--container-prefix", "Upper"],
      ["--container-prefix", "-dash"],
      ["--container-prefix", "a/b"],
      ["--container-prefix", "a..b"],
      ["--container-prefix", "a-"],
      ["--container-prefix", "a._b"],
      ["--container-prefix", "x".repeat(33)],
      ["--container-prefix", "a b"],
    ])
      assert.throws(() => containerPrefix(argv), /--container-prefix needs/, JSON.stringify(argv));
  });
});

describe("containerPrefix for other harnesses", () => {
  it("returns the harness's own default only when neither the flag nor the variable is set", () => {
    assert.equal(containerPrefix([], {}, "cockpit-context-runtime"), "cockpit-context-runtime");
    assert.equal(
      containerPrefix([], { TEST_CONTAINER_PREFIX: "ci-x" }, "cockpit-context-runtime"),
      "ci-x",
    );
    assert.throws(
      () => containerPrefix([], { TEST_CONTAINER_PREFIX: "" }, "cockpit-context-runtime"),
      /TEST_CONTAINER_PREFIX needs a Docker name prefix/,
    );
  });
});
