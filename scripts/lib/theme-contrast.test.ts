import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

test("field outlines (--input) reach 3:1 on every surface a field sits on, light and dark", () => {
  // WCAG 1.4.11 non-text contrast: the border is what shows where to type.
  // --border is decorative (dividers, cards) and is not held to this.
  const css = readFileSync(GLOBALS_CSS, "utf-8");
  const outlines = measurePairs(
    css,
    (["background", "card", "popover", "muted"] as const).map((surface) => ({
      text: "input",
      surface,
      themes: ["light", "dark"] as const,
    })),
  );
  assert.deepEqual(
    outlines
      .filter((r) => r.ratio < 3)
      .map((r) => `${r.theme}: ${r.label} = ${r.ratio.toFixed(2)}:1`),
    [],
  );
  // The dark field fill (bg-input/30) must keep placeholder text readable.
  const placeholders = measurePairs(
    css,
    (["background", "card", "popover"] as const).map((surface) => ({
      text: "muted-foreground",
      surface,
      tint: { token: "input", alpha: 0.3 },
      themes: ["dark"] as const,
    })),
  );
  assert.deepEqual(
    placeholders.filter((r) => r.ratio < AA_TEXT).map((r) => `${r.theme}: ${r.label}`),
    [],
  );
  // The original light --input read 1.25:1 on white.
  const white = parseOklch(readTokenBlock(css, ":root").get("background") ?? "");
  assert.ok(contrastRatio(oklchToSrgb(0.925, 0.005, 214.3), white) < 3);
});

test("a long toast title stays inside the pill and the action button text reaches 4.5:1", () => {
  const css = readFileSync(GLOBALS_CSS, "utf-8");
  // A long title must not outgrow sileo's 350px pill (the icon ended up half
  // outside it): the header row is capped and the title ellipsised.
  assert.equal(
    ruleDeclarations(css, ":root [data-sileo-viewport] [data-sileo-header-inner]").get("max-width"),
    "calc(var(--sileo-width) - 1rem - 10px)",
  );
  assert.equal(
    ruleDeclarations(
      css,
      ":root [data-sileo-viewport] [data-sileo-header-inner] [data-sileo-title]",
    ).get("text-overflow"),
    "ellipsis",
  );
  // The action button ("Try again") writes --popover-foreground on an 8% (14%
  // on hover) tint of itself over the pill.
  const button = ruleDeclarations(
    css,
    ":root [data-sileo-viewport] [data-sileo-button][data-state]",
  );
  assert.equal(button.get("--sileo-btn-color"), "var(--popover-foreground)");
  const pairs = ["--sileo-btn-bg", "--sileo-btn-bg-hover"].map((key) => {
    const mix = /^color-mix\(in oklch, var\(--popover-foreground\) (\d+)%, transparent\)$/.exec(
      button.get(key) ?? "",
    );
    assert.ok(mix, key);
    return {
      text: "popover-foreground",
      surface: "popover",
      tint: { token: "popover-foreground", alpha: Number(mix[1]) / 100 },
      themes: ["light", "dark"] as const,
    };
  });
  assert.deepEqual(
    measurePairs(css, pairs)
      .filter((r) => r.ratio < AA_TEXT)
      .map((r) => `${r.theme}: toast button ${r.label}`),
    [],
  );
});

const UI_COMPONENTS = resolve(import.meta.dirname, "../../packages/ui/src/components");
const uiSource = (file: string) => readFileSync(resolve(UI_COMPONENTS, file), "utf-8");

test("every menu and popup draws on an opaque popover surface", () => {
  // A translucent menu (bg-popover/70 + blur) let a banner tint it (CTX-14),
  // and select kept it after dropdown-menu was fixed. Every class string that
  // paints a popover surface (text-popover-foreground) in every ui component
  // is checked, so a new menu, combobox or picker is covered too.
  const surfaces: string[] = [];
  for (const file of readdirSync(UI_COMPONENTS)) {
    if (!file.endsWith(".tsx") || file.endsWith(".test.tsx")) continue;
    const text = uiSource(file);
    for (const match of text.matchAll(/"([^"\n]*text-popover-foreground[^"\n]*)"/g)) {
      const literal = match[1] ?? "";
      surfaces.push(file);
      assert.match(literal, /(?:^|\s)bg-popover(?:\s|$)/, file);
      assert.doesNotMatch(literal, /bg-popover\/\d+|backdrop-/, file);
    }
    assert.doesNotMatch(text, /bg-popover\/\d+/, file);
  }
  // The scan cannot pass by finding nothing.
  for (const file of ["dropdown-menu.tsx", "select.tsx", "popover.tsx", "command.tsx"]) {
    assert.ok(surfaces.includes(file), `${file} paints a popover surface`);
  }
});

const SURFACES = ["background", "card", "popover", "muted"] as const;
const failures = (results: { theme: string; label: string; ratio: number }[], min: number) =>
  results
    .filter((r) => r.ratio < min)
    .map((r) => `${r.theme}: ${r.label} = ${r.ratio.toFixed(2)}:1`);

test("focus rings reach 3:1 on every surface and clearly differ from the resting outline", () => {
  // The focused border (border-ring) replaces the resting --input outline, so
  // besides 3:1 on the surface (WCAG 1.4.11) it must read as a change: >= 2:1
  // against --input (WCAG 2.4.13 style). In dark the border also sits next to
  // the field's own fill (bg-input/30).
  const css = readFileSync(GLOBALS_CSS, "utf-8");
  const both = ["light", "dark"] as const;
  const onSurfaces = measurePairs(css, [
    ...["ring", "sidebar-ring"].flatMap((text) =>
      [...SURFACES, "sidebar"].map((surface) => ({ text, surface, themes: both })),
    ),
    ...(["background", "card", "popover"] as const).map((surface) => ({
      text: "ring",
      surface,
      tint: { token: "input", alpha: 0.3 },
      themes: ["dark"] as const,
    })),
  ]);
  assert.deepEqual(failures(onSurfaces, 3), []);
  const vsOutline = measurePairs(css, [
    { text: "ring", surface: "input", themes: both },
    { text: "sidebar-ring", surface: "input", themes: both },
  ]);
  assert.deepEqual(failures(vsOutline, 2), []);
});

test("invalid borders reach 3:1 on the surface and on the dark field fill", () => {
  const css = readFileSync(GLOBALS_CSS, "utf-8");
  const results = measurePairs(css, [
    ...SURFACES.map((surface) => ({
      text: "destructive",
      surface,
      themes: ["light", "dark"] as const,
    })),
    ...SURFACES.map((surface) => ({
      text: "destructive",
      surface,
      tint: { token: "input", alpha: 0.3 },
      themes: ["dark"] as const,
    })),
  ]);
  assert.deepEqual(failures(results, 3), []);
});

test("controls draw opaque invalid borders and outline buttons use the field outline", () => {
  for (const file of [
    "input.tsx",
    "textarea.tsx",
    "select.tsx",
    "button.tsx",
    "checkbox.tsx",
    "switch.tsx",
  ]) {
    assert.doesNotMatch(uiSource(file), /border-destructive\/\d+/, file);
  }
  // The outline button's border is its only edge (theme toggle, Sign in):
  // --input (3:1) in both themes, never the decorative --border (1.25:1).
  const outline = /outline:\s*"([^"]*)"/.exec(uiSource("button.tsx"))?.[1] ?? "";
  assert.match(outline, /(?:^|\s)border-input(?:\s|$)/);
  assert.doesNotMatch(outline, /border-border|dark:border-/);
});

test("the old focus ring and dark invalid border measure as failing, so the checks discriminate", () => {
  const css = readFileSync(GLOBALS_CSS, "utf-8");
  // Before: --ring was --primary (light) and --primary-text (dark).
  const old = css
    .replace(/(:root \{[\s\S]*?)--ring: [^;]+;/, "$1--ring: var(--primary);")
    .replace(/(\.dark \{[\s\S]*?)--ring: [^;]+;/, "$1--ring: var(--primary-text);");
  for (const r of measurePairs(old, [
    { text: "ring", surface: "input", themes: ["light", "dark"] },
  ])) {
    assert.ok(r.ratio < 2, `${r.theme}: old ${r.label} = ${r.ratio.toFixed(2)}`);
  }
  // Before: dark invalid borders were destructive/50, measured on the field
  // fill (input/30) over a card.
  const dark = new Map([...readTokenBlock(css, ":root"), ...readTokenBlock(css, ".dark")]);
  const color = (name: string) => parseOklch(dark.get(name) ?? "");
  const mix = (top: readonly number[], alpha: number, base: readonly number[]) =>
    [0, 1, 2].map((i) => top[i]! * alpha + base[i]! * (1 - alpha)) as unknown as [
      number,
      number,
      number,
    ];
  const fill = mix(color("input"), 0.3, color("card"));
  assert.ok(contrastRatio(mix(color("destructive"), 0.5, fill), fill) < 3);
});

/** Every declaration of `prop` in rules whose selector is exactly `selector`,
 *  with the `@media` params it sits under ("" at the top level or in @layer). */
function findDeclarations(css: string, selector: string, prop: string) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: { value: string; media: string }[] = [];
  const stack: string[] = [];
  let buffer = "";
  const flush = (text: string) => {
    if (stack.at(-1) !== selector) return;
    const media =
      [...stack]
        .reverse()
        .find((p) => p.startsWith("@media"))
        ?.slice(6)
        .trim() ?? "";
    for (const decl of text.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      if (decl[1] === prop) found.push({ value: decl[2]!.replace(/\s+/g, " ").trim(), media });
    }
  };
  for (const char of source) {
    if (char === "{") {
      const cut = buffer.lastIndexOf(";") + 1;
      flush(buffer.slice(0, cut));
      stack.push(buffer.slice(cut).replace(/\s+/g, " ").trim());
      buffer = "";
    } else if (char === "}") {
      flush(`${buffer};`);
      stack.pop();
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return found;
}

test("bottom toasts sit above the phone bottom nav, and above the safe area without one", () => {
  const css = readFileSync(GLOBALS_CSS, "utf-8");
  assert.deepEqual(
    findDeclarations(css, ':root [data-sileo-viewport][data-position^="bottom"]', "bottom"),
    [{ value: "max(var(--bottom-nav-height), var(--safe-area-bottom))", media: "" }],
  );
  // 0 unless a bottom nav is on screen, which is only below md (48rem).
  assert.deepEqual(findDeclarations(css, ":root", "--bottom-nav-height"), [
    { value: "0px", media: "" },
  ]);
  assert.deepEqual(findDeclarations(css, ":root:has([data-bottom-nav])", "--bottom-nav-height"), [
    { value: "calc(var(--bottom-nav-bar) + var(--safe-area-bottom))", media: "(width < 48rem)" },
  ]);
  // The nav draws its bar at --bottom-nav-bar, hides from md and pads the
  // safe area itself, so the offset is exactly the room it takes.
  assert.deepEqual(findDeclarations(css, ":root", "--bottom-nav-bar"), [
    { value: "3.5rem", media: "" },
  ]);
  const nav = readFileSync(
    resolve(import.meta.dirname, "../../apps/web/src/components/bottom-nav.tsx"),
    "utf-8",
  );
  const navClass = /const NAV_CLASS =\s*"([^"]*)"/.exec(nav)?.[1] ?? "";
  assert.match(navClass, /(?:^|\s)md:hidden(?:\s|$)/);
  const navs = [...nav.matchAll(/<nav\b([\s\S]*?)>\s*<div className="([^"]*)"/g)];
  assert.equal(navs.length, 2);
  for (const [, attributes = "", bar = ""] of navs) {
    assert.ok(bar.split(/\s+/).includes("h-(--bottom-nav-bar)"), bar);
    assert.match(attributes, /data-bottom-nav\b/);
    assert.match(attributes, /className=\{NAV_CLASS\}/);
    assert.match(attributes, /paddingBottom: "var\(--safe-area-bottom\)"/);
  }
});

test("a toast's action button is at least 44px tall on a touch screen", () => {
  // sileo draws it 1.75rem (28px) tall with a fixed `height`.
  const css = readFileSync(GLOBALS_CSS, "utf-8");
  const button = ":root [data-sileo-viewport] [data-sileo-button]";
  assert.deepEqual(findDeclarations(css, button, "min-height"), [
    { value: "44px", media: "(pointer: coarse)" },
  ]);
  assert.deepEqual(findDeclarations(css, button, "height"), [
    { value: "auto", media: "(pointer: coarse)" },
  ]);
});

test("an Off switch fills its track with the opaque --input, which the 3:1 checks cover", () => {
  // A translucent track (dark:bg-input/80) composites below 3:1 on a card.
  const source = readFileSync(
    resolve(import.meta.dirname, "../../packages/ui/src/components/switch.tsx"),
    "utf-8",
  );
  assert.ok(source.includes("data-unchecked:bg-input "));
  assert.doesNotMatch(source, /data-unchecked:bg-input\/\d+/);
});

test("muted text stays readable on every hovered --input fill", () => {
  // Select and outline triggers hover to a stronger `bg-input/NN` while they
  // still show a muted placeholder; at /50 the dark fill fell below 4.5:1 once
  // --input reached 3:1. Every `hover:bg-input/NN` in the ui package and the
  // web app is checked in the themes it applies to.
  const css = readFileSync(GLOBALS_CSS, "utf-8");
  const roots = [
    resolve(import.meta.dirname, "../../packages/ui/src"),
    resolve(import.meta.dirname, "../../apps/web/src"),
  ];
  const fills: string[] = [];
  const bad: string[] = [];
  for (const root of roots) {
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      const source = readFileSync(resolve(root, file), "utf-8");
      for (const match of source.matchAll(/(?<![\w-])((?:[\w-]+:)*hover:)bg-input\/(\d+)/g)) {
        fills.push(`${file}: ${match[0]}`);
        const themes = (match[1] ?? "").split(":").includes("dark")
          ? (["dark"] as const)
          : (["light", "dark"] as const);
        const results = measurePairs(
          css,
          (["background", "card", "popover"] as const).map((surface) => ({
            text: "muted-foreground",
            surface,
            tint: { token: "input", alpha: Number(match[2]) / 100 },
            themes,
          })),
        );
        for (const r of results.filter((r) => r.ratio < AA_TEXT))
          bad.push(`${file} ${match[0]} ${r.theme}: ${r.label} = ${r.ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(bad, []);
  // The select, outline-button and language-switcher hovers.
  assert.ok(fills.length >= 3, fills.join("\n"));
});

test("menu and picker search fields: muted placeholder on an opaque muted fill", () => {
  // Tailwind's default placeholder is the text colour at 50%; a translucent
  // bg-input fill moves with the --input outline token. Unprefixed and dark:
  // InputGroup's own `dark:bg-input/30` would otherwise win in the dark theme.
  for (const file of ["command.tsx", "async-combobox.tsx"]) {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../packages/ui/src/components", file),
      "utf-8",
    );
    assert.ok(source.includes("placeholder:text-muted-foreground"), file);
    assert.match(source, /InputGroup className="[^"]*(?<![\w:-])bg-muted[^"]*dark:bg-muted/);
    assert.doesNotMatch(source, /InputGroup className="[^"]*bg-input\/\d+/);
  }
});
