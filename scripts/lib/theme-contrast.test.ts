import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  AA_TEXT,
  contrastRatio,
  measurePairs,
  oklchToSrgb,
  parseOklch,
  readTokenBlock,
} from "./theme-contrast.ts";

const GLOBALS_CSS = resolve(import.meta.dirname, "../../packages/ui/src/styles/globals.css");

test("contrastRatio matches the WCAG reference points", () => {
  assert.equal(contrastRatio([0, 0, 0], [1, 1, 1]).toFixed(2), "21.00");
  assert.equal(contrastRatio([1, 1, 1], [1, 1, 1]), 1);
  // #767676 on white is the classic 4.54:1 grey.
  const grey = 0x76 / 255;
  assert.equal(contrastRatio([grey, grey, grey], [1, 1, 1]).toFixed(2), "4.54");
});

test("oklchToSrgb maps the OKLch extremes to black and white", () => {
  const white = oklchToSrgb(1, 0, 0);
  const black = oklchToSrgb(0, 0, 0);
  for (const v of white) assert.ok(Math.abs(v - 1) < 1e-4);
  for (const v of black) assert.ok(Math.abs(v) < 1e-9);
});

test("parseOklch rejects values it cannot measure", () => {
  assert.throws(() => parseOklch("oklch(1 0 0 / 10%)"), /opaque oklch/);
  assert.throws(() => parseOklch("#fff"), /opaque oklch/);
});

test("readTokenBlock reads one exact selector", () => {
  const css = ":root {\n  --a: oklch(1 0 0);\n}\n.dark {\n  --a: oklch(0 0 0);\n}\n";
  assert.equal(readTokenBlock(css, ":root").get("a"), "oklch(1 0 0)");
  assert.equal(readTokenBlock(css, ".dark").get("a"), "oklch(0 0 0)");
  assert.throws(() => readTokenBlock(css, ".light"), /no `\.light \{` block/);
});

test("measurePairs follows var() references and composites tints", () => {
  const css = [
    ":root {",
    "  --background: oklch(1 0 0);",
    "  --card: var(--background);",
    "  --text: oklch(0 0 0);",
    "}",
    ".dark {",
    "  --background: oklch(0 0 0);",
    "  --text: oklch(1 0 0);",
    "}",
  ].join("\n");
  const [light, dark] = measurePairs(css, [
    { text: "text", surface: "card", themes: ["light", "dark"] },
  ]);
  assert.equal(light!.ratio.toFixed(2), "21.00");
  assert.equal(dark!.ratio.toFixed(2), "21.00");
  const [tinted] = measurePairs(css, [
    { text: "text", surface: "card", tint: { token: "text", alpha: 0.5 }, themes: ["light"] },
  ]);
  assert.ok(tinted!.ratio < 21 && tinted!.ratio > 1);
});

test("every text token in globals.css reaches 4.5:1 on its surfaces, light and dark", () => {
  const results = measurePairs(readFileSync(GLOBALS_CSS, "utf-8"));
  assert.ok(results.length > 0);
  const failing = results.filter((r) => r.ratio < AA_TEXT);
  assert.deepEqual(
    failing.map((r) => `${r.theme}: ${r.label} = ${r.ratio.toFixed(2)}:1`),
    [],
    "raise the text token (or darken/lighten the surface) in the :root / .dark preset tokens",
  );
});
