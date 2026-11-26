/**
 * `pnpm check:layout`: real-browser geometry check of the shell rules
 * against a running dev stack, see docs/ui.md § Shell rules
 * It is not part of CI:
 * it needs agent-browser and its Chromium plus the app's server and database.
 * Run it after touching a shell, the footer, the header, page-level chrome or
 * the toast theme.
 *
 *   pnpm check:layout --url http://localhost:3001
 *   CHECK_LAYOUT_PASSWORD=… pnpm check:layout --url … --login admin@example.test
 *   … --no-sandbox                       Ubuntu 23.10+ (AppArmor) Chromium
 *
 * The app has no mock mode, so `--url` points at `pnpm dev` (web + server).
 * `--login` signs in with that account (the password comes from
 * CHECK_LAYOUT_PASSWORD, never the command line; an account with a second
 * factor also needs a current code in CHECK_LAYOUT_TOTP) and adds the
 * signed-in pages; without it they are skipped. Use an admin account: the admin users page is
 * the one with a sticky sub-nav, and an admin without a second factor also
 * shows the 2FA banner inside the scroller.
 *
 * At 390×844, 1280×800, 1440×1600 and 390×300 (where every page scrolls), on
 * the landing page, the privacy notice, the 404, the sign-in page and (signed
 * in) the ongoing and admin users pages, it checks that:
 * - the document never scrolls and the shell's `<main>` is the scroller;
 * - the public shell's footer is the scroller's last box: scrolled to the end,
 *   its bottom is the scroller's bottom (±1px), so on a short page it sits at
 *   the bottom of the viewport and on a long one it follows the content;
 * - the 404 renders inside the public shell (header and footer present);
 * - `<main>` reserves no scrollbar gutter, and every full-width rule (the
 *   public header's `<hr>`, the app header's `border-b`, footer `border-t`, the admin sub-nav's and the 2FA banner's
 *   `border-b`) reaches the viewport's right edge (inside a scrolling `<main>`,
 *   its visible scrollbar) from the start of its column: 0, or the left of
 *   AppFrame's content column, after the sidebar;
 * - a toast (the file-drop notice), stored theme light then dark with the OS
 *   set to the other one, renders in the stored theme and is filled with its
 *   popover colour (not inverted) and its title and badge reach 4.5:1 on it.
 *
 * Classic (non-overlay) scrollbars are what expose a reserved gutter; headless
 * Chromium on Linux draws them, overlay scrollbars on macOS hide the defect.
 */
import { execFileSync, spawn } from "node:child_process";

// One session per run: two checks running at once (two checkouts, two agents) must not share a browser.
const SESSION = `check-layout-${process.pid}`;
const THEME_KEY = "cockpit-context-theme";

/** What the in-page probe reports. Pure data, so `judgeLayout` is testable. */
export interface Probe {
  vw: number;
  docScroll: number;
  header: boolean;
  /** `scrollbar`: the width `<main>` gives up to a scrollbar right now (offsetWidth − clientWidth). */
  main: { bottom: number; scrollable: boolean; scrollbar: number } | null;
  /** The public footer after scrolling `<main>` to its end, or null. */
  footer: { bottom: number; lastInMain: boolean } | null;
  /**
   * `inMain`: the rule is inside the scroller, so a visible scrollbar is its right edge. `start`:
   * where its left edge belongs, 0 or the left of AppFrame's content column (after the sidebar).
   */
  rules: { name: string; left: number; right: number; inMain: boolean; start?: number }[];
  toast: {
    dark: boolean;
    fill: string;
    popover: string;
    title: number;
    badge: number;
    button: number | null;
  } | null;
}

export interface Expect {
  footer: boolean;
  /** The theme the stored choice asks for; the OS is set to the opposite one. */
  toast?: "light" | "dark";
}

/** Returns one message per broken rule; empty means the page passes. */
export function judgeLayout(page: string, probe: Probe, expect: Expect): string[] {
  const bad: string[] = [];
  if (probe.docScroll > 0)
    bad.push(`${page}: the document scrolls by ${probe.docScroll}px; only <main> may scroll`);
  if (!probe.main) bad.push(`${page}: no <main> page scroller`);
  if (!probe.header) bad.push(`${page}: no shell header`);
  if (expect.footer) {
    if (!probe.footer) bad.push(`${page}: no public footer`);
    else {
      if (!probe.footer.lastInMain)
        bad.push(`${page}: the footer is not the last box in the scroller's content column`);
      if (probe.main && Math.abs(probe.footer.bottom - probe.main.bottom) > 1)
        bad.push(
          `${page}: scrolled to the end, the footer ends at ${probe.footer.bottom}px, the scroller at ${probe.main.bottom}px (${probe.main.scrollable ? "long" : "short"} page)`,
        );
    }
  }
  // A scrollable scroller shows a scrollbar at the viewport's right edge, and a
  // rule inside it meets that scrollbar, as on any scrolling page. A scroller
  // that does not scroll but still gives up width reserves an empty gutter.
  const scrollbar = probe.main?.scrollable ? probe.main.scrollbar : 0;
  if (probe.main && !probe.main.scrollable && probe.main.scrollbar > 0)
    bad.push(
      `${page}: <main> reserves a ${probe.main.scrollbar}px scrollbar gutter on a page that does not scroll`,
    );
  for (const rule of probe.rules) {
    const edge = probe.vw - (rule.inMain ? scrollbar : 0);
    const start = rule.start ?? 0;
    if (rule.left > start || edge - rule.right > 0)
      bad.push(
        `${page}: ${rule.name} spans ${rule.left}…${rule.right}px, not ${start}…${edge}px; full-bleed rules reach both edges of their column`,
      );
  }
  if (expect.toast) {
    const toast = probe.toast;
    if (!toast) bad.push(`${page}: no toast appeared`);
    else {
      if (toast.dark !== (expect.toast === "dark"))
        bad.push(
          `${page}: the stored ${expect.toast} theme lost to the OS (the page rendered ${toast.dark ? "dark" : "light"})`,
        );
      if (toast.fill !== toast.popover)
        bad.push(
          `${page}: the toast is filled ${toast.fill}, not the ${toast.dark ? "dark" : "light"} theme's popover ${toast.popover}`,
        );
      for (const [part, ratio] of [
        ["title", toast.title],
        ["badge", toast.badge],
        ["action", toast.button],
      ] as const) {
        if (ratio !== null && ratio < 4.5)
          bad.push(`${page}: toast ${part} contrast ${ratio}:1 is below 4.5:1`);
      }
    }
  }
  return bad;
}

// Runs in the page (agent-browser eval). Self-contained: no closures.
const PROBE = `(async () => {
  const html = document.documentElement;
  const vw = html.clientWidth;
  const main = document.querySelector('[data-scroll-restoration-id="app-main"]');
  const out = { vw, docScroll: document.scrollingElement.scrollHeight - window.innerHeight, header: !!document.querySelector("header"), main: null, footer: null, rules: [], toast: null };
  if (main) {
    main.scrollTop = main.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.main = { bottom: Math.round(main.getBoundingClientRect().bottom), scrollable: main.scrollHeight > main.clientHeight, scrollbar: main.offsetWidth - main.clientWidth };
    const footer = main.querySelector("footer[data-public-footer]");
    if (footer) {
      const column = footer.parentElement;
      out.footer = { bottom: Math.round(footer.getBoundingClientRect().bottom), lastInMain: column.parentElement === main && column.lastElementChild === footer && main.children.length === 1 };
      out.rules.push({ name: "footer border-t", left: Math.round(footer.getBoundingClientRect().left), right: Math.round(footer.getBoundingClientRect().right), inMain: true });
    }
    main.scrollTop = 0;
  }
  // The app header draws its rule as its own border-b; the public header uses an <hr>.
  for (const header of document.querySelectorAll("header")) if (parseFloat(getComputedStyle(header).borderBottomWidth) > 0) out.rules.push({ name: "header border-b", left: Math.round(header.getBoundingClientRect().left), right: Math.round(header.getBoundingClientRect().right), inMain: !!main && main.contains(header) });
  for (const hr of document.querySelectorAll("header hr")) out.rules.push({ name: "header <hr>", left: Math.round(hr.getBoundingClientRect().left), right: Math.round(hr.getBoundingClientRect().right), inMain: !!main && main.contains(hr) });
  // Bands inside AppFrame's content column (#main-content) start where the column starts, after the sidebar.
  const column = document.getElementById("main-content");
  const startOf = (el) => (column && column !== main && column.contains(el) ? Math.round(column.getBoundingClientRect().left) : 0);
  for (const nav of document.querySelectorAll("main nav.border-b")) out.rules.push({ name: "sub-nav border-b", left: Math.round(nav.getBoundingClientRect().left), right: Math.round(nav.getBoundingClientRect().right), inMain: true, start: startOf(nav) });
  for (const banner of document.querySelectorAll("main [role=alert].border-b")) out.rules.push({ name: "banner border-b", left: Math.round(banner.getBoundingClientRect().left), right: Math.round(banner.getBoundingClientRect().right), inMain: true, start: startOf(banner) });
  const pill = document.querySelector("[data-sileo-viewport] [data-sileo-pill]");
  if (pill) {
    const ctx = document.createElement("canvas").getContext("2d");
    const rgb = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
    const probe = document.createElement("div");
    probe.style.color = "var(--popover)";
    document.body.append(probe);
    const popover = rgb(getComputedStyle(probe).color);
    probe.remove();
    const fill = rgb(getComputedStyle(pill).fill);
    const color = (sel) => { const el = document.querySelector("[data-sileo-viewport] " + sel); return el ? rgb(getComputedStyle(el).color) : null; };
    const title = color("[data-sileo-title]"), badge = color("[data-sileo-badge]"), button = color("[data-sileo-button]");
    out.toast = { dark: html.classList.contains("dark"), fill: fill.join(","), popover: popover.join(","), title: title ? ratio(title, fill) : 0, badge: badge ? ratio(badge, fill) : 0, button: button ? ratio(button, fill) : null };
  }
  return JSON.stringify(out);
})()`;

/**
 * One agent-browser command. Asynchronous, so a signal (Ctrl+C, a kill) is
 * handled between commands instead of after the whole run.
 */
function browser(args: string[], input?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn("agent-browser", ["--session", SESSION, ...args], {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      err += chunk;
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done(out.trim())
        : fail(new Error(`agent-browser ${args.join(" ")} exited ${code}: ${err.trim()}`)),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

function closeBrowser(): void {
  try {
    execFileSync("agent-browser", ["--session", SESSION, "close"], { stdio: "ignore" });
  } catch {}
}

async function evalJson<T>(script: string): Promise<T> {
  let value: unknown = JSON.parse(await browser(["eval", "--stdin"], script));
  if (typeof value === "string") value = JSON.parse(value);
  return value as T;
}

async function waitFor(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the dev server did not answer ${url} within ${ms / 1000}s`);
}

interface Page {
  name: string;
  path: string;
  expect: Expect;
  /** Wait for this selector before probing. */
  ready: string;
  signedIn?: boolean;
}

const PAGES: Page[] = [
  {
    name: "landing",
    path: "/en-US",
    expect: { footer: true },
    ready: "footer[data-public-footer]",
  },
  {
    name: "privacy",
    path: "/en-US/privacy",
    expect: { footer: true },
    ready: "footer[data-public-footer]",
  },
  {
    name: "404",
    path: "/en-US/check-layout-missing",
    expect: { footer: true },
    ready: "footer[data-public-footer]",
  },
  { name: "sign-in", path: "/en-US/login", expect: { footer: false }, ready: "form" },
  {
    name: "ongoing",
    path: "/en-US/ongoing",
    expect: { footer: false },
    ready: "main h1",
    signedIn: true,
  },
  {
    name: "admin users",
    path: "/en-US/admin/users",
    expect: { footer: false },
    ready: "main nav.border-b",
    signedIn: true,
  },
];
const VIEWPORTS = [
  [390, 844],
  [1280, 800],
  [1440, 1600],
  [390, 300],
] as const;

// An unclaimed file drop shows the neutral "file ignored" toast (FileDropGuard). The guard mounts
// after hydration (ClientOnly), so drop again every half second until a toast shows (20s at most).
const DROP_FILE = `(async () => {
  const pill = () => document.querySelector("[data-sileo-viewport] [data-sileo-pill]");
  for (let i = 0; i < 40 && !pill(); i++) {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "x.txt"));
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 500));
  }
  return !!pill();
})()`;

/**
 * Types a value into a React-controlled input through the native setter. The script goes over
 * stdin, so a password never appears in a process's arguments or in a failed command's message.
 */
function fillScript(selector: string, value: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
}

/** After the sign-in submit: "app" once the app opens, "code" at the second-factor step. */
const SIGN_IN_STEP = `(async () => {
  for (let i = 0; i < 60; i++) {
    if (location.pathname.endsWith("/ongoing")) return "app";
    if (document.getElementById("totp-code")) return "code";
    await new Promise((r) => setTimeout(r, 500));
  }
  return "still on " + location.pathname + " after 30s";
})()`;
/** Clicks Verify once React has enabled it for the typed code (the button after the code field). */
const VERIFY_CODE = `(async () => {
  const button = document.getElementById("totp-code").closest("div").nextElementSibling;
  for (let i = 0; i < 20 && button.disabled; i++) await new Promise((r) => setTimeout(r, 100));
  button.click();
  return true;
})()`;

async function signIn(base: string, email: string, password: string): Promise<void> {
  await browser(["open", `${base}/en-US/login`]);
  await browser(["wait", "input[autocomplete=current-password]"]);
  await browser(["eval", "--stdin"], fillScript("input[type=email]", email));
  try {
    await browser(
      ["eval", "--stdin"],
      fillScript("input[autocomplete=current-password]", password),
    );
  } catch {
    // agent-browser may echo the failing script; never pass its output on.
    throw new Error("check:layout: could not type the password into the sign-in form");
  }
  await browser(["click", "form button[type=submit]"]);
  // Either the app opens, or an account with a second factor gets the code step.
  const step: unknown = JSON.parse(await browser(["eval", "--stdin"], SIGN_IN_STEP));
  if (step === "code") {
    const code = process.env.CHECK_LAYOUT_TOTP;
    if (!code)
      throw new Error(
        "check:layout: this account has a second factor; put a current code in CHECK_LAYOUT_TOTP (or use an account still in its enrollment grace)",
      );
    try {
      await browser(["eval", "--stdin"], `${fillScript("#totp-code", code)} && ${VERIFY_CODE}`);
    } catch {
      throw new Error("check:layout: could not submit the verification code");
    }
  } else if (step !== "app") {
    throw new Error(`check:layout: sign-in did not open the app (${step})`);
  }
  await browser(["wait", "--url", "**/ongoing"]);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const base = option("--url")?.replace(/\/$/, "");
  if (!base) {
    console.error(
      "check:layout: pass --url <web dev server>, e.g. --url http://localhost:3001 (docs/ui.md § Shell rules)",
    );
    return 2;
  }
  const email = option("--login");
  const password = process.env.CHECK_LAYOUT_PASSWORD;
  if (email && !password) {
    console.error("check:layout: --login needs the password in CHECK_LAYOUT_PASSWORD");
    return 2;
  }
  const onSignal = (signal: NodeJS.Signals) => {
    closeBrowser();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const failures: string[] = [];
  try {
    await waitFor(`${base}/en-US`, 120_000);
    await browser([
      "open",
      "about:blank",
      ...(args.includes("--no-sandbox") ? ["--args", "--no-sandbox"] : []),
    ]);
    await browser(["cookies", "clear"]);
    const pages = PAGES.filter((page) => !page.signedIn || email);
    if (pages.length < PAGES.length)
      console.log("check:layout: no --login, so the signed-in pages are skipped");
    const anonymous = pages.filter((page) => !page.signedIn);
    const signedIn = pages.filter((page) => page.signedIn);
    const measure = async (list: Page[]) => {
      for (const [w, h] of VIEWPORTS) {
        await browser(["set", "viewport", String(w), String(h)]);
        for (const page of list) {
          await browser(["open", `${base}${page.path}`]);
          await browser(["wait", page.ready]);
          const label = `${page.name} ${w}×${h}`;
          const probe = await evalJson<Probe>(PROBE);
          failures.push(...judgeLayout(label, probe, page.expect));
          console.log(
            `check:layout: ${label} measured (${probe.main?.scrollable ? "long" : "short"} page)`,
          );
        }
      }
    };
    // Signed-in pages first, while a CHECK_LAYOUT_TOTP code is still current; then sign out.
    if (email && password && signedIn.length) {
      await signIn(base, email, password);
      await measure(signedIn);
      await browser(["cookies", "clear"]);
    }
    await measure(anonymous);
    // Toasts, light and dark at one width, each with the OS set to the other.
    await browser(["set", "viewport", "1280", "800"]);
    for (const theme of ["light", "dark"] as const) {
      await browser(["set", "media", theme === "dark" ? "light" : "dark"]);
      await browser(["open", `${base}/en-US`]);
      await browser(["eval", `localStorage.setItem('${THEME_KEY}', '${theme}'); true`]);
      await browser(["open", `${base}/en-US`]);
      await browser(["wait", "footer[data-public-footer]"]);
      await browser(["eval", "--stdin"], DROP_FILE);
      await browser(["wait", "[data-sileo-viewport] [data-sileo-pill]"]);
      await browser(["wait", "800"]);
      failures.push(
        ...judgeLayout(`toast ${theme}`, await evalJson<Probe>(PROBE), {
          footer: true,
          toast: theme,
        }),
      );
      console.log(`check:layout: toast ${theme} measured`);
    }
  } finally {
    closeBrowser();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  for (const failure of failures) console.error(`check:layout: ${failure}`);
  console.log(
    failures.length ? `check:layout: ${failures.length} failure(s)` : "check:layout: passed",
  );
  return failures.length ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) process.exitCode = await main();
