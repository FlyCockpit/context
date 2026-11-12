import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureCommand, redactCapture } from "./e2e-capture.mjs";

test("redactCapture removes multiline and localized credential fields and escaped secrets", () => {
  const text = `- dialog "Add"
  - textbox "Clave privada" [ref=e1]: unregistered-value
unindented-continuation
tail==

    - text: multiline-value
  - textbox "Contraseña" [ref=e2]: other-value
  - button "Save" [ref=e3]
trace: ${JSON.stringify("fixture-phrase\nsecond-line")}`;
  const safe = redactCapture(text, ["fixture-phrase\nsecond-line"]);
  for (const value of [
    "unregistered-value",
    "unindented-continuation",
    "tail==",
    "multiline-value",
    "other-value",
    "fixture-phrase",
  ])
    assert.ok(!safe.includes(value));
  assert.ok(safe.includes('button "Save"'));
  assert.ok(safe.includes("ref=e1"));
  // Construct inert PEM markers as the secret-policy self-tests do. There is
  // no key material here; tracked files must not contain literal PEM headers.
  const header = ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" ");
  const footer = ["-----END OPENSSH", "PRIVATE KEY-----"].join(" ");
  assert.throws(() => redactCapture(header, []));
  assert.throws(() =>
    redactCapture(`${header}\nunknown-body`, [`${header}\nknown-body\n${footer}`]),
  );
  assert.equal(
    redactCapture('trace: "short-tail=="', ["body\nshort-tail==\n"]),
    'trace: "[redacted]"',
  );
});

test("captureCommand redacts successful output and artifacts; failed CLI never emits argv or streams", () => {
  const directory = mkdtempSync(join(tmpdir(), "e2e-capture-test-"));
  try {
    const secretFile = join(directory, "credential");
    const outputFile = join(directory, "evidence");
    const secret = "synthetic-credential-for-regression";
    writeFileSync(secretFile, secret, { mode: 0o600 });
    const request = {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]);",
        secret,
      ],
      secretFiles: [secretFile],
      outputFile,
    };
    assert.equal(captureCommand(request), "[redacted][redacted]");
    assert.equal(readFileSync(outputFile, "utf8"), "[redacted][redacted]");
    for (const failed of [
      { ...request, args: ["-e", "console.error(process.argv[1]); process.exit(1)", secret] },
      { ...request, command: `/missing/${secret}` },
      { ...request, secretFiles: [`/missing/${secret}`] },
    ]) {
      const result = spawnSync(
        process.execPath,
        [new URL("./e2e-capture.mjs", import.meta.url).pathname],
        {
          input: JSON.stringify(failed),
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Evidence command failed; arguments and output withheld.\n");
      assert.equal(readFileSync(outputFile, "utf8"), "[redacted][redacted]");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
