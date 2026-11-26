/**
 * The app's own settings for `pnpm check:dialogs` and
 * `pnpm check:shell-loading`: how to sign in, every dialog to open, and the
 * signed-in pages to hard-reload. The check scripts and
 * `browser-check-lib.ts` stay identical to the template's; only this file
 * changes per app.
 *
 * Cockpit Context has no mock mode, so both checks run against a running dev
 * stack and sign in for real with an existing admin account:
 *
 *   pnpm check:dialogs --url http://localhost:3001 --login admin@example.test \
 *     --password-file /path/outside/the/repo/admin-password
 *
 * The password is the first line of `--password-file`; it is never a
 * command-line value, never read from the environment and never committed.
 * An account with a second factor (past its enrollment grace) also needs a
 * current code as the first line of `--totp-file`. The account is used for both
 * the "user" and the "admin" cases, so it must be an admin.
 *
 * The dialogs open on the demo seed's data (`pnpm db:seed`): a few cases need
 * a row to act on (a pending proposal, an SSH key, a checkout with an edited
 * overview, a cloned repository) and fail with "could not open" without it.
 */
import { readFileSync } from "node:fs";

import type { CheckRun } from "./browser-check-lib.ts";

/**
 * Start a mock-mode dev server when no `--url` is given. An app without mock
 * mode sets this to false, runs its stack, passes `--url`, and signs in for
 * real in `signIn` below.
 */
export const MOCK_SERVER = false;

export type Role = "anonymous" | "user" | "admin";

export interface SignInOptions {
  /** Per-procedure mock scenarios; unused without mock mode. */
  overrides?: Record<string, string>;
  /** Slow mock responses; unused without mock mode (the shell check still throttles). */
  slow?: boolean;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** The first line of a file named by an option, or undefined without the option. */
function firstLineOf(args: string[], name: string): string | undefined {
  const file = option(args, name);
  return file ? readFileSync(file, "utf8").split(/\r?\n/)[0] : undefined;
}

/** The sign-in account from `--login` and `--password-file`. */
function credentials(args: string[]): { email: string; password: string } {
  const email = option(args, "--login");
  const password = firstLineOf(args, "--password-file");
  if (!email || !password) throw new Error("pass --login <admin email> and --password-file <file>");
  return { email, password };
}

/**
 * Types a value into a React-controlled input through the native setter. The
 * script goes over stdin, so a password never appears in a process's
 * arguments.
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

/** The account this browser session is signed in as, so each case does not sign in again. */
let signedInAs: string | undefined;

/**
 * Leaves the browser signed in as `role` (on a page of the app). Mock mode:
 * the mock cookie. This app: fill the sign-in form once per run with the
 * account from `--login`; later calls keep that session.
 */
export async function signIn(run: CheckRun, role: Role, _options: SignInOptions = {}) {
  const { base, browser, args } = run;
  if (role === "anonymous") {
    await browser.run(["cookies", "clear"]);
    signedInAs = undefined;
    await browser.run(["open", `${base}/en-US/login`]);
    return;
  }
  const { email, password } = credentials(args);
  if (signedInAs === email) return;
  await browser.run(["cookies", "clear"]);
  await browser.run(["open", `${base}/en-US/login`]);
  await browser.run(["wait", "input[type=password]"]);
  await browser.run(["eval", "--stdin"], fillScript("input[type=email]", email));
  try {
    await browser.run(["eval", "--stdin"], fillScript("input[type=password]", password));
  } catch {
    // agent-browser may echo the failing script; never pass its output on.
    throw new Error("could not type the password into the sign-in form");
  }
  await browser.run(["click", "form button[type=submit]"]);
  // Either the app opens, or an account with a second factor gets the code step.
  const step: unknown = JSON.parse(await browser.run(["eval", "--stdin"], SIGN_IN_STEP));
  if (step === "code") {
    const code = firstLineOf(args, "--totp-file");
    if (!code)
      throw new Error(
        "this account has a second factor; pass --totp-file with a current code (or use an account still in its enrollment grace)",
      );
    try {
      await browser.run(["eval", "--stdin"], `${fillScript("#totp-code", code)} && ${VERIFY_CODE}`);
    } catch {
      throw new Error("could not submit the verification code");
    }
  } else if (step !== "app") {
    throw new Error(`sign-in did not open the app (${step})`);
  }
  await browser.run(["wait", "--url", "**/ongoing"]);
  signedInAs = email;
}

export type DialogStep =
  /** Click the first element matching a CSS selector. */
  | { click: string }
  /** Click the button, link or menu item whose trimmed text is exactly this. */
  | { clickText: string }
  /** Wait for a selector (after a click that opens another page). */
  | { wait: string };

export interface DialogCase {
  /** Unique; shown in failures and used by `--only`. */
  name: string;
  /** Path with the locale, opened after signing in as `role`. */
  path: string;
  role: Role;
  overrides?: Record<string, string>;
  /** Wait for this selector before the steps. */
  ready: string;
  /** Steps that open the dialog. */
  steps: DialogStep[];
}

const CHECKOUT_ACTIONS = '[aria-label="Actions for v5.59.0"]';
/** The demo seed's "TanStack Query (React)" package, reached from the list (ids differ per database). */
const TANSTACK_QUERY_LINK = 'main a[data-identifier="npm:@tanstack/react-query"]';
const OPEN_TANSTACK_QUERY: DialogStep[] = [
  { click: TANSTACK_QUERY_LINK },
  { wait: CHECKOUT_ACTIONS },
];
/** The first finished conversation in the list (a live run offers no Delete). */
const CONVERSATION_LINK = 'main a[href*="/conversations/"]:not([data-live])';
const ROW_ACTIONS = '[aria-label^="Actions for "]';

/**
 * Every dialog the app ships, confirmations included. A dialog that cannot
 * fit moves to a page or a wide side sheet and leaves this list; there is no
 * exemption field. Wide side sheets (Add/Edit package, Approve proposal,
 * checkout overview and its edit, Rename token) are not dialogs.
 */
export const DIALOGS: DialogCase[] = [
  {
    name: "Add git host",
    path: "/en-US/access/known-hosts",
    role: "user",
    ready: "main h1",
    steps: [{ clickText: "Add host" }],
  },
  {
    name: "Import SSH key",
    path: "/en-US/access/ssh-keys",
    role: "user",
    ready: "main h1",
    steps: [{ clickText: "Import key" }],
  },
  {
    name: "Generate SSH key",
    path: "/en-US/access/ssh-keys",
    role: "user",
    ready: "main h1",
    steps: [{ clickText: "Generate key" }],
  },
  {
    name: "Show SSH public key",
    path: "/en-US/access/ssh-keys",
    role: "user",
    ready: ROW_ACTIONS,
    steps: [{ click: ROW_ACTIONS }, { clickText: "Show public key" }],
  },
  {
    name: "Delete SSH key",
    path: "/en-US/access/ssh-keys",
    role: "user",
    ready: ROW_ACTIONS,
    steps: [{ click: ROW_ACTIONS }, { clickText: "Delete" }],
  },
  {
    name: "Create MCP token",
    path: "/en-US/access/tokens",
    role: "user",
    ready: "main h1",
    steps: [{ clickText: "Create token" }],
  },
  {
    name: "Revoke MCP token",
    path: "/en-US/access/tokens",
    role: "user",
    ready: ROW_ACTIONS,
    steps: [{ click: ROW_ACTIONS }, { clickText: "Revoke" }],
  },
  {
    name: "Ask",
    path: "/en-US/packages",
    role: "user",
    ready: TANSTACK_QUERY_LINK,
    steps: [...OPEN_TANSTACK_QUERY, { clickText: "Ask" }],
  },
  {
    name: "Delete package",
    path: "/en-US/packages",
    role: "user",
    ready: TANSTACK_QUERY_LINK,
    steps: [
      ...OPEN_TANSTACK_QUERY,
      { click: '[aria-label="Actions for npm:@tanstack/react-query"]' },
      { clickText: "Delete package" },
    ],
  },
  {
    name: "Revert checkout overview",
    path: "/en-US/packages",
    role: "user",
    ready: TANSTACK_QUERY_LINK,
    steps: [
      ...OPEN_TANSTACK_QUERY,
      { click: CHECKOUT_ACTIONS },
      { clickText: "Revert to model-written" },
    ],
  },
  {
    name: "Delete checkout",
    path: "/en-US/packages",
    role: "user",
    ready: TANSTACK_QUERY_LINK,
    steps: [...OPEN_TANSTACK_QUERY, { click: CHECKOUT_ACTIONS }, { clickText: "Delete checkout" }],
  },
  {
    name: "Reject proposal",
    path: "/en-US/packages/proposals",
    role: "admin",
    ready: "main ul > li button",
    steps: [{ clickText: "Reject" }],
  },
  {
    name: "Delete conversation",
    path: "/en-US/conversations",
    role: "user",
    ready: CONVERSATION_LINK,
    steps: [
      { click: CONVERSATION_LINK },
      { wait: '[aria-label="Delete conversation"]' },
      { click: '[aria-label="Delete conversation"]' },
    ],
  },
  {
    name: "Invite user",
    path: "/en-US/admin/users",
    role: "admin",
    ready: ROW_ACTIONS,
    steps: [{ clickText: "Invite user" }],
  },
  {
    name: "Delete repository clone",
    path: "/en-US/admin/storage",
    role: "admin",
    ready: '[aria-label^="Delete the clone of "]',
    steps: [{ click: '[aria-label^="Delete the clone of "]' }],
  },
  {
    name: "Run seed",
    path: "/en-US/admin/seed",
    role: "admin",
    ready: 'main [data-slot="card"] button',
    steps: [{ clickText: "Run seed…" }],
  },
];

export interface ShellPage {
  name: string;
  path: string;
  role: Role;
  /**
   * A selector that exists only once the page's real content has loaded, not
   * in any skeleton (a row's action button, say; a card or a list item also
   * exists in the skeleton).
   */
  ready: string;
}

/** Signed-in pages `check:shell-loading` hard-reloads (pick two or more different shapes). */
export const SHELL_PAGES: ShellPage[] = [
  {
    name: "packages",
    path: "/en-US/packages",
    role: "user",
    ready: ROW_ACTIONS,
  },
  {
    name: "tokens",
    path: "/en-US/access/tokens",
    role: "user",
    ready: ROW_ACTIONS,
  },
  {
    name: "admin users",
    path: "/en-US/admin/users",
    role: "admin",
    ready: ROW_ACTIONS,
  },
];
