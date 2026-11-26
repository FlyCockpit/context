/**
 * The header logo slot (components/app-name-link.tsx): 2rem (32px at the
 * default root size), with 32/64/128px sources. Width descriptors plus
 * `sizes` let the browser pick by the drawn size times the pixel density, so
 * a large screen whose root size scales the slot up (docs/ui.md § Viewport
 * scale) still gets a sharp file (a `2x`/`4x` list would hand it the 32px
 * one at 1×). The files are generated, never drawn
 * by hand: `pnpm --filter web generate-pwa-assets` derives them from
 * `apps/web/assets/logo.png`, the same source as the favicon and the install
 * icons (apps/web/pwa-assets.config.ts), and vite-plugin-pwa's `pwaAssets`
 * integration serves the same set in dev and emits it in builds. docs/ui.md
 * § Logo slot.
 */
export const APP_LOGO = {
  /** CSS px, both sides: the `<img>` reserves this box before the file loads. */
  size: 32,
  src: "/pwa-32x32.png",
  srcSet: "/pwa-32x32.png 32w, /pwa-64x64.png 64w, /pwa-128x128.png 128w",
  /**
   * The largest width the slot is drawn at: 2rem at a root font scaled up to
   * 150% on big screens. A literal, not "2rem": `sizes` resolves `rem`
   * against the browser's initial font size, never the page's scaled root.
   */
  sizes: "48px",
} as const;
