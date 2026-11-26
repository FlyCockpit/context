/**
 * The app's own settings for `pnpm check:layout`, `pnpm check:dialogs` and
 * `pnpm check:shell-loading`: how to sign in, every dialog to open, and the
 * signed-in pages to hard-reload. The check scripts and
 * `browser-check-lib.ts` follow the template's; this file is the app's own.
 *
 * Cockpit Context has no mock mode, so the checks run against a running dev
 * stack and sign in for real with an existing admin account:
 *
 *   pnpm check:dialogs --url http://localhost:3001 --login admin@example.test \
 *     --password-file /path/outside/the/repo/admin-password
 *
 * The password is the first line of `--password-file`; it is never a
 * command-line value, never read from the environment and never committed.
 * An account with a second factor (past its enrollment grace) also needs a
 * current code as the first line of `--totp-file` (a run signs in once, so the
 * code only has to be current when it starts). The account is used for both
 * the "user" and the "admin" cases, so it must be an admin.
 *
 * The dialogs open on the demo seed's data (`pnpm db:seed`): a few cases need
 * a row to act on (a pending proposal, an SSH key, a checkout with an edited
 * overview, a cloned repository) and fail with "could not open" without it.
 */
import { existsSync, readFileSync } from "node:fs";

import { type CheckRun, formSignIn } from "./browser-check-lib.ts";

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
  const value = index >= 0 ? args[index + 1] : undefined;
  return value?.startsWith("--") ? undefined : value;
}

/**
 * The first line of the file an option names, or undefined without the
 * option. Fails with what to do when the file is missing or its first line is
 * empty; never with the file's contents.
 */
function firstLineOf(args: string[], name: string, what: string): string | undefined {
  if (!args.includes(name)) return undefined;
  const file = option(args, name);
  if (!file) throw new Error(`${name} needs a file holding ${what} on its first line`);
  if (!existsSync(file)) throw new Error(`no file at ${file} (${name}, ${what})`);
  const line = readFileSync(file, "utf8").split(/\r?\n/)[0];
  if (!line) throw new Error(`the first line of ${file} (${name}) is empty; it should be ${what}`);
  return line;
}

/**
 * The sign-in account from `--login`, `--password-file` and (for an account
 * with a second factor) `--totp-file`, or undefined when no `--login` is
 * given. Fails with what to do when a part is missing.
 */
export function credentials(args: string[]) {
  if (!args.includes("--login")) return undefined;
  const email = option(args, "--login");
  if (!email) throw new Error("--login needs the admin account's email");
  const password = firstLineOf(args, "--password-file", "the account's password");
  if (!password) throw new Error("--login needs --password-file <file with the password>");
  const code = firstLineOf(args, "--totp-file", "a current one-time code");
  return { email, password, totp: code ? () => code : undefined };
}

/**
 * The account each browser session is signed in as right now ("anonymous", or
 * the email), so a run signs in once, not once per page.
 */
const signedInAs = new WeakMap<CheckRun["browser"], string>();

/**
 * Leaves the browser signed in as `role` (on a page of the app). Mock mode:
 * the mock cookie. This app: fill the sign-in form once per run with the
 * account from `--login` (`formSignIn`); later calls keep that session. The
 * one account serves both the "user" and the "admin" cases. "anonymous"
 * clears the cookies (signing out) and opens the sign-in page.
 */
export async function signIn(run: CheckRun, role: Role, _options: SignInOptions = {}) {
  const { base, browser } = run;
  const account = role === "anonymous" ? undefined : credentials(run.args);
  if (role !== "anonymous" && !account)
    throw new Error(
      "the signed-in cases need --login <admin email> and --password-file <file> (and --totp-file <file> for an account with a second factor)",
    );
  const wanted = account?.email ?? "anonymous";
  if (signedInAs.get(browser) === wanted) return;
  // Another account's session first ends: sign-out is just dropping its cookies.
  await browser.run(["cookies", "clear"]);
  signedInAs.delete(browser);
  if (account) await formSignIn(run, account);
  else await browser.run(["open", `${base}/en-US/login`]);
  signedInAs.set(browser, wanted);
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
  /** What the account must hold for `ready` to appear (shown when it does not). */
  needs?: string;
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

/** What the cases below need on the stack (shown when `ready` never appears). */
const AN_SSH_KEY =
  "an SSH key (import or generate one under Access, SSH keys; the demo seed adds none)";
const AN_MCP_TOKEN = "an MCP token (pnpm db:seed adds one)";
const TANSTACK_QUERY =
  "the demo seed's TanStack Query package and its v5.59.0 checkout (pnpm db:seed)";

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
    needs: AN_SSH_KEY,
  },
  {
    name: "Delete SSH key",
    path: "/en-US/access/ssh-keys",
    role: "user",
    ready: ROW_ACTIONS,
    steps: [{ click: ROW_ACTIONS }, { clickText: "Delete" }],
    needs: AN_SSH_KEY,
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
    needs: AN_MCP_TOKEN,
  },
  {
    name: "Ask",
    path: "/en-US/packages",
    role: "user",
    ready: TANSTACK_QUERY_LINK,
    steps: [...OPEN_TANSTACK_QUERY, { clickText: "Ask" }],
    needs: TANSTACK_QUERY,
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
    needs: TANSTACK_QUERY,
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
    needs: `${TANSTACK_QUERY}, with its overview edited by hand (Revert shows only then)`,
  },
  {
    name: "Delete checkout",
    path: "/en-US/packages",
    role: "user",
    ready: TANSTACK_QUERY_LINK,
    steps: [...OPEN_TANSTACK_QUERY, { click: CHECKOUT_ACTIONS }, { clickText: "Delete checkout" }],
    needs: TANSTACK_QUERY,
  },
  {
    name: "Reject proposal",
    path: "/en-US/packages/proposals",
    role: "admin",
    ready: "main ul > li button",
    steps: [{ clickText: "Reject" }],
    needs: "a pending proposal (pnpm db:seed adds one)",
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
    needs: "a finished conversation (pnpm db:seed adds some)",
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
    needs: "a repository on the storage page (pnpm db:seed adds repository rows)",
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
  /** What the account must hold for `ready` to appear (shown when it does not). */
  needs?: string;
}

/** Signed-in pages `check:shell-loading` hard-reloads (pick two or more different shapes). */
export const SHELL_PAGES: ShellPage[] = [
  {
    name: "packages",
    path: "/en-US/packages",
    role: "user",
    ready: ROW_ACTIONS,
    needs: "a package in the account (pnpm db:seed adds some)",
  },
  {
    name: "tokens",
    path: "/en-US/access/tokens",
    role: "user",
    ready: ROW_ACTIONS,
    needs: AN_MCP_TOKEN,
  },
  {
    name: "admin users",
    path: "/en-US/admin/users",
    role: "admin",
    ready: ROW_ACTIONS,
  },
];
