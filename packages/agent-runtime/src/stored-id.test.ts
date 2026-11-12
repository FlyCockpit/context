import { describe, expect, it } from "vitest";

import { storedResultId } from "./stored-id";

describe("storedResultId", () => {
  it("dedupes identical bodies at the same trust level", () => {
    expect(storedResultId("same body", true)).toBe(storedResultId("same body", true));
    expect(storedResultId("same body", false)).toBe(storedResultId("same body", false));
  });

  // THE TRUST-DOWNGRADE REGRESSION. Stored entries are `{ body, untrusted }`,
  // and `untrusted` is what re-wraps every retrieved slice in the injection
  // fence. Keying on the body alone makes a trusted and an untrusted result with
  // the same bytes the SAME entry: the later `put` overwrites the earlier record
  // wholesale, and a retrieval against the untrusted marker comes back
  // `untrusted: false` — attacker-authored text handed to the model as ordinary
  // tool output, fence silently disarmed.
  it("never collides across trust levels", () => {
    expect(storedResultId("same body", true)).not.toBe(storedResultId("same body", false));
  });

  // The separator is a prefix, so it must not be forgeable by a body that simply
  // starts with the other level's word.
  it("is not spoofable by a body that mimics the domain separator", () => {
    expect(storedResultId("untrusted body", false)).not.toBe(storedResultId("body", true));
    expect(storedResultId("trusted body", true)).not.toBe(storedResultId("body", false));
  });

  it("is a short, stable hex id", () => {
    expect(storedResultId("x", false)).toMatch(/^[0-9a-f]{16}$/);
  });
});
