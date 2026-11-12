import { describe, expect, it } from "vitest";

import { isSendKey } from "./composer-keys";

const key = (
  overrides: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {},
) => ({
  key: overrides.key ?? "Enter",
  shiftKey: overrides.shiftKey ?? false,
  nativeEvent: { isComposing: overrides.isComposing ?? false },
});

describe("isSendKey", () => {
  it("sends on a bare Enter", () => {
    expect(isSendKey(key())).toBe(true);
  });

  it("inserts a newline on Shift+Enter", () => {
    expect(isSendKey(key({ shiftKey: true }))).toBe(false);
  });

  it("ignores every other key", () => {
    expect(isSendKey(key({ key: "a" }))).toBe(false);
    expect(isSendKey(key({ key: "Tab" }))).toBe(false);
  });

  // THE IME REGRESSION. While a Japanese/Chinese/Korean IME has an active
  // composition, Enter is how the user ACCEPTS the candidate on screen — it
  // belongs to the IME. Submitting on it fires on the first Enter of nearly
  // every multi-character word, sending a half-composed fragment and clearing
  // the draft. Invisible on a Latin keyboard, which is exactly why it ships.
  it("leaves Enter to the IME while a composition is active", () => {
    expect(isSendKey(key({ isComposing: true }))).toBe(false);
  });

  // Some synthetic and older events carry no `nativeEvent` at all. Absent is not
  // composing — treating it as composing would make Enter stop sending outright.
  it("treats a missing composition flag as not composing", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(isSendKey({ key: "Enter", shiftKey: false, nativeEvent: {} })).toBe(true);
  });
});
