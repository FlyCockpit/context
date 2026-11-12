import { describe, expect, it } from "vitest";

import { cursorToken, entityId, longText, shortText } from "./schemas";

describe("bounded strings", () => {
  it("caps entityId / shortText / longText / cursorToken", () => {
    expect(entityId.safeParse("").success).toBe(false);
    expect(entityId.safeParse("a".repeat(65)).success).toBe(false);
    expect(shortText.safeParse("a".repeat(201)).success).toBe(false);
    expect(longText.safeParse("a".repeat(10_001)).success).toBe(false);
  });

  it("rejects blank text schemas and trims what they keep", () => {
    expect(shortText.safeParse("").success).toBe(false);
    expect(shortText.safeParse("   ").success).toBe(false);
    expect(longText.safeParse("").success).toBe(false);
    expect(longText.safeParse("\n\t ").success).toBe(false);
    expect(shortText.parse("  Title  ")).toBe("Title");
    expect(longText.parse("  Body  ")).toBe("Body");
    expect(cursorToken.safeParse("").success).toBe(false);
    expect(cursorToken.safeParse("   ").success).toBe(false);
    expect(cursorToken.safeParse("a".repeat(129)).success).toBe(false);
  });
});
