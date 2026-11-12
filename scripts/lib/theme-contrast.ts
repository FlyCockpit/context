/**
 * Text-contrast check for the theme tokens in packages/ui/src/styles/globals.css.
 *
 *   pnpm policy:theme-contrast
 *
 * Reads the `:root` (light) and `.dark` token blocks, converts each OKLch
 * value to sRGB and measures the WCAG 2 contrast ratio of every text token
 * against every surface it sits on in the app. Body text needs 4.5:1 (WCAG AA,
 * 1.4.3). Theme updates rewrite both blocks, so a new preset that drops
 * a pair below 4.5:1 fails here instead of shipping grey-on-grey copy.
 *
 * Tinted surfaces (`bg-destructive/10`) are composited over their base the way
 * the browser does: the token at that alpha over the opaque surface, in sRGB.
 * The destructive tints listed are every rest, hover and focus tint the
 * destructive button, menu item, error alerts and status pill ship with; a tint not in the
 * list is not measured.
 */

type Rgb = readonly [number, number, number];

type Theme = "light" | "dark";

export interface ContrastPair {
  /** Text token, without the leading `--`. */
  text: string;
  /** Opaque surface token, without the leading `--`. */
  surface: string;
  /** Optional tint drawn over the surface: a token at an alpha (0-1). */
  tint?: { token: string; alpha: number };
  themes: readonly Theme[];
}

const BOTH: readonly Theme[] = ["light", "dark"];

/** The surfaces muted text (secondary copy, captions, placeholders) sits on. */
const MUTED_SURFACES = [
  "background",
  "card",
  "popover",
  "muted",
  "accent",
  "secondary",
  "sidebar",
  "sidebar-accent",
] as const;

export const AA_TEXT = 4.5;

const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...MUTED_SURFACES.map((surface) => ({ text: "muted-foreground", surface, themes: BOTH })),
  ...(["background", "card", "popover"] as const).map((surface) => ({
    text: "destructive",
    surface,
    themes: BOTH,
  })),
  // Destructive text on its own tint, at every alpha that ships (rest, hover
  // and focus), over each surface it sits on:
  //   both   /5: inline errors and failed Ask alerts;
  //   light /10: destructive button at rest, destructive menu item focused;
  //   light /15: destructive button hovered, "bad" status pill;
  //   dark  /10: login error alert;
  //   dark  /15: destructive button at rest, "bad" status pill;
  //   dark  /20: destructive button hovered, destructive menu item focused.
  // A new destructive tint in packages/ui or apps/web is added here.
  ...(["background", "card", "popover"] as const).flatMap((surface) => [
    ...[0.05, 0.1, 0.15].map((alpha) => ({
      text: "destructive",
      surface,
      tint: { token: "destructive", alpha },
      themes: ["light"] as const,
    })),
    ...[0.05, 0.1, 0.15, 0.2].map((alpha) => ({
      text: "destructive",
      surface,
      tint: { token: "destructive", alpha },
      themes: ["dark"] as const,
    })),
  ]),
];

/** Pulls `--name: value;` declarations out of the first block whose selector matches exactly. */
export function readTokenBlock(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`globals.css has no \`${selector} {\` block`);
  const tokens = new Map<string, string>();
  for (const decl of match[2]!.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(decl[1]!, decl[2]!.trim());
  }
  return tokens;
}

/** Light tokens are `:root`; dark tokens are `:root` overlaid with `.dark`. */
function themeTokens(css: string, theme: Theme): Map<string, string> {
  const light = readTokenBlock(css, ":root");
  if (theme === "light") return light;
  return new Map([...light, ...readTokenBlock(css, ".dark")]);
}

function resolveToken(tokens: Map<string, string>, name: string, depth = 0): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`token --${name} is not defined`);
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  if (!ref) return value;
  if (depth > 8) throw new Error(`token --${name} has a var() cycle`);
  return resolveToken(tokens, ref[1]!, depth + 1);
}

/** OKLch to gamma-encoded sRGB (0-1, clipped), via OKLab and linear sRGB. */
export function oklchToSrgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const encode = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [encode(linear[0]!), encode(linear[1]!), encode(linear[2]!)];
}

/** Parses an opaque `oklch(L C H)` value. Alpha, `none` and other spaces are rejected. */
export function parseOklch(value: string): Rgb {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!match) throw new Error(`expected an opaque oklch(L C H) value, got \`${value}\``);
  return oklchToSrgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function composite(top: Rgb, alpha: number, base: Rgb): Rgb {
  return [
    top[0] * alpha + base[0] * (1 - alpha),
    top[1] * alpha + base[1] * (1 - alpha),
    top[2] * alpha + base[2] * (1 - alpha),
  ];
}

export interface ContrastResult {
  theme: Theme;
  label: string;
  ratio: number;
}

export function measurePairs(
  css: string,
  pairs: readonly ContrastPair[] = CONTRAST_PAIRS,
): ContrastResult[] {
  const results: ContrastResult[] = [];
  for (const theme of ["light", "dark"] as const) {
    const tokens = themeTokens(css, theme);
    const color = (name: string) => parseOklch(resolveToken(tokens, name));
    for (const pair of pairs) {
      if (!pair.themes.includes(theme)) continue;
      let surface = color(pair.surface);
      let label = `${pair.text} on ${pair.surface}`;
      if (pair.tint) {
        surface = composite(color(pair.tint.token), pair.tint.alpha, surface);
        label = `${pair.text} on ${pair.tint.token}/${Math.round(pair.tint.alpha * 100)} over ${pair.surface}`;
      }
      results.push({ theme, label, ratio: contrastRatio(color(pair.text), surface) });
    }
  }
  return results;
}
