import { describe, expect, it } from "vitest";
import { isValidEncryptionKeyring, parseEncryptionKeyring } from "./encryption-keyring.js";

const keyOf = (fill: number) => Buffer.alloc(32, fill).toString("base64");

describe("parseEncryptionKeyring", () => {
  it("uses the first entry for encryption and keeps every entry for decryption", () => {
    const ring = parseEncryptionKeyring(`v2:${keyOf(2)}, v1:${keyOf(1)}`);
    expect(ring.current.version).toBe("v2");
    expect(Buffer.from(ring.current.key)).toEqual(Buffer.alloc(32, 2));
    expect([...ring.byVersion.keys()]).toEqual(["v2", "v1"]);
    expect(Buffer.from(ring.byVersion.get("v1") ?? [])).toEqual(Buffer.alloc(32, 1));
  });

  it.each([
    ["empty", ""],
    ["missing version", keyOf(1)],
    ["bad version characters", `v 1:${keyOf(1)}`],
    ["short key", `v1:${Buffer.alloc(16, 1).toString("base64")}`],
    ["long key", `v1:${Buffer.alloc(33, 1).toString("base64")}`],
    ["url-safe base64", `v1:${keyOf(251).replace(/\+/g, "-").replace(/\//g, "_")}`],
    ["duplicate version", `v1:${keyOf(1)},v1:${keyOf(2)}`],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseEncryptionKeyring(raw)).toThrow(/COCKPIT_CONTEXT_ENCRYPTION_KEYS/);
    expect(isValidEncryptionKeyring(raw)).toBe(false);
  });

  it("never echoes key material in its errors", () => {
    const secretish = "S3cr3tMaterialThatMustNotLeak";
    expect(() => parseEncryptionKeyring(`v1:${secretish}`)).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining(secretish) }),
    );
  });
});
