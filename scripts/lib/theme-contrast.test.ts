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

/** The declarations of the one unlayered rule whose selector is exactly `selector`. */
function ruleDeclarations(css: string, selector: string): Map<string, string> {
  const unlayered = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(unlayered);
  if (!match) throw new Error(`globals.css has no toast rule \`${selector}\``);
  const declarations = new Map<string, string>();
  for (const decl of match[2]!.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(decl[1]!, decl[2]!.replace(/\s+/g, " ").trim());
  }
  return declarations;
}

test("toasts are a popover surface whose inks reach 4.5:1 on it, light and dark", () => {
  // sileo's own palette inverts the theme; globals.css repaints it from the
  // tokens. Every state ink it maps, and its text colour, must hold up on the
  // fill it maps. See docs/ui.md § Shell rules
  const css = readFileSync(GLOBALS_CSS, "utf-8");
  const alias = (value: string | undefined) => /^var\(--([\w-]+)\)$/.exec(value ?? "")?.[1];
  const fill = ruleDeclarations(
    css,
    ":root [data-sileo-viewport] :is([data-sileo-pill], [data-sileo-body])",
  ).get("fill");
  assert.equal(alias(fill), "popover");
  const viewport = ruleDeclarations(css, ":root [data-sileo-viewport]");
  const pairs = ["success", "loading", "error", "warning", "info", "action"].map((state) => {
    const ink = alias(viewport.get(`--sileo-state-${state}`));
    assert.ok(ink, `--sileo-state-${state} maps to a token`);
    return { text: ink, surface: "popover", themes: ["light", "dark"] as const };
  });
  for (const selector of [
    ":root [data-sileo-viewport] [data-sileo-title][data-state]",
    ":root [data-sileo-viewport] [data-sileo-description]",
  ]) {
    assert.equal(
      alias(ruleDeclarations(css, selector).get("color")),
      "popover-foreground",
      selector,
    );
  }
  pairs.push({ text: "popover-foreground", surface: "popover", themes: ["light", "dark"] });
  // The badge ink sits on the pill itself (measured above), not on sileo's 20% tint.
  assert.equal(
    ruleDeclarations(css, ":root [data-sileo-viewport] [data-sileo-badge][data-state]").get(
      "--sileo-tone-bg",
    ),
    "transparent",
  );
  const failing = measurePairs(css, pairs).filter((r) => r.ratio < AA_TEXT);
  assert.deepEqual(
    failing.map((r) => `${r.theme}: toast ${r.label} = ${r.ratio.toFixed(2)}:1`),
    [],
  );
});
