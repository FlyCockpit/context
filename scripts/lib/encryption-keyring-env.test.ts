import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateEncryptionKeyring,
  readEncryptionKeyringValue,
  withEncryptionKeyring,
} from "./encryption-keyring-env.ts";

const FIXED = `v1:${Buffer.alloc(32, 9).toString("base64")}`;

test("generateEncryptionKeyring mints v1 plus a base64 32-byte key", () => {
  const keyring = generateEncryptionKeyring();
  assert.match(keyring, /^v1:[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(keyring.slice(3), "base64").length, 32);
  assert.notEqual(generateEncryptionKeyring(), keyring);
});

test("readEncryptionKeyringValue is null when absent, commented, or empty", () => {
  assert.equal(readEncryptionKeyringValue(""), null);
  assert.equal(readEncryptionKeyringValue(`# COCKPIT_CONTEXT_ENCRYPTION_KEYS=${FIXED}\n`), null);
  assert.equal(readEncryptionKeyringValue("COCKPIT_CONTEXT_ENCRYPTION_KEYS=\n"), null);
  assert.equal(readEncryptionKeyringValue(`COCKPIT_CONTEXT_ENCRYPTION_KEYS='${FIXED}'\n`), FIXED);
});

test("withEncryptionKeyring fills the empty template line in place", () => {
  const out = withEncryptionKeyring("A=1\nCOCKPIT_CONTEXT_ENCRYPTION_KEYS=\nB=2\n", FIXED);
  assert.equal(out, `A=1\nCOCKPIT_CONTEXT_ENCRYPTION_KEYS=${FIXED}\nB=2\n`);
});

test("withEncryptionKeyring appends the line when it is missing", () => {
  const out = withEncryptionKeyring("A=1\n\n", FIXED);
  assert.equal(out, `A=1\nCOCKPIT_CONTEXT_ENCRYPTION_KEYS=${FIXED}\n`);
});

test("withEncryptionKeyring never replaces an existing keyring", () => {
  const input = `COCKPIT_CONTEXT_ENCRYPTION_KEYS=${FIXED}\n`;
  assert.equal(withEncryptionKeyring(input), input);
});
