import { isAdminRole } from "@cockpit-context/auth/roles";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Ellipsis,
  Fingerprint,
  Home,
  KeyRound,
  Link2,
  MessagesSquare,
  Package,
  Server,
  Settings,
  Shield,
} from "lucide-react";

/**
 * - `public`: everyone. `anonymous`: signed-out visitors only (the signed-in
 *   app has its own home, Ongoing).
 * - `authenticated`: any signed-in user. `admin`: the shared admin role helper.
 */
type NavAudience = "public" | "anonymous" | "authenticated" | "admin";
/**
 * - `desktop`: the header's main nav (signed-out chrome only; signed-in
 *   navigation lives in the sidebar).
 * - `sidebar`: the signed-in app sidebar (desktop) and the More sheet (mobile).
 * - `mobile`: the BottomNav tabs. Sidebar items that are not tabs go into More.
 * - `userMenu`: the account menu.
 */
type NavPlacement = "desktop" | "mobile" | "sidebar" | "userMenu";

export type AppNavPath =
  | "/"
  | "/ongoing"
  | "/conversations"
  | "/packages"
  | "/access"
  | "/access/tokens"
  | "/access/connections"
  | "/access/ssh-keys"
  | "/access/known-hosts"
  | "/settings"
  | "/settings/security"
  | "/admin";
export type LangNavRoute = "/$lang" | `/$lang${Exclude<AppNavPath, "/">}`;

export type RouteNavItem = {
  /** Path WITHOUT the `/$lang/` prefix, starts with "/". Use "/" for root. */
  path: AppNavPath;
  /** Translation key. App nav keys live in `nav`; nested nav may use another namespace. */
  labelKey: string;
  /** Icon rendered by shell navigation surfaces. */
  icon: LucideIcon;
  /** `activeOptions.exact` for the <Link>. */
  exact: boolean;
};

export type AppNavId =
  | "home"
  | "ongoing"
  | "conversations"
  | "packages"
  | "access"
  | "settings"
  | "admin";

export type AppNavItem = RouteNavItem & {
  id: AppNavId;
  audience: NavAudience;
  placements: readonly NavPlacement[];
  /** Sidebar group: the main sections, or the footer (settings, admin). */
  group: "main" | "footer";
  /** One-line hint (`nav:hints.<id>`), shown in the More sheet and as the sidebar tooltip. */
  hintKey?: string;
};

type VisibleNavInput = {
  placement: NavPlacement;
  isAuthenticated: boolean;
  role?: unknown;
};

function section(
  id: Exclude<AppNavId, "home">,
  path: AppNavPath,
  icon: LucideIcon,
  placements: readonly NavPlacement[],
  group: "main" | "footer" = "main",
  audience: NavAudience = "authenticated",
): AppNavItem {
  return {
    id,
    path,
    labelKey: `items.${id}`,
    hintKey: `hints.${id}`,
    icon,
    exact: false,
    audience,
    placements,
    group,
  };
}

/** One list, in sidebar order. */
const appNavItems: AppNavItem[] = [
  {
    id: "home",
    path: "/",
    labelKey: "items.home",
    icon: Home,
    exact: true,
    audience: "anonymous",
    placements: ["desktop", "mobile"],
    group: "main",
  },
  section("ongoing", "/ongoing", Activity, ["mobile", "sidebar"]),
  section("conversations", "/conversations", MessagesSquare, ["mobile", "sidebar"]),
  section("packages", "/packages", Package, ["mobile", "sidebar"]),
  section("access", "/access", KeyRound, ["mobile", "sidebar"]),
  section("settings", "/settings", Settings, ["sidebar", "userMenu"], "footer"),
  section("admin", "/admin", Shield, ["sidebar", "userMenu"], "footer", "admin"),
];

function canSeeNavItem(item: AppNavItem, input: Pick<VisibleNavInput, "isAuthenticated" | "role">) {
  if (item.audience === "public") return true;
  if (item.audience === "anonymous") return !input.isAuthenticated;
  if (!input.isAuthenticated) return false;
  if (item.audience === "authenticated") return true;
  return isAdminRole(input.role);
}

export function getNavItems(input: VisibleNavInput): AppNavItem[] {
  return appNavItems.filter(
    (item) => item.placements.includes(input.placement) && canSeeNavItem(item, input),
  );
}

export function toLangRoute(path: AppNavPath): LangNavRoute {
  if (path === "/") return "/$lang";
  return `/$lang${path}`;
}

/**
 * The badge count of one nav section (0 hides the badge): Packages shows the
 * owner's pending agent proposals (`home.status`).
 */
export function navBadgeCount(
  id: AppNavId,
  status: { pendingProposals: number } | undefined,
): number {
  if (id === "packages") return status?.pendingProposals ?? 0;
  return 0;
}

/** Icon for the mobile More sheet trigger. */
export const moreNavIcon: LucideIcon = Ellipsis;

/**
 * Settings sub-nav tabs, in visual order. Reuses the existing i18n keys.
 */
export const settingsNavItems: RouteNavItem[] = [
  {
    path: "/settings",
    labelKey: "settings:navProfile",
    icon: Settings,
    exact: true,
  },
  {
    path: "/settings/security",
    labelKey: "settings:navSecurity",
    icon: Shield,
    exact: false,
  },
];

/** Access section tabs (`access.tsx`), in visual order. */
export const accessNavItems: RouteNavItem[] = [
  { path: "/access/tokens", labelKey: "dashboard:access.tabs.tokens", icon: KeyRound, exact: true },
  {
    path: "/access/connections",
    labelKey: "dashboard:access.tabs.connections",
    icon: Link2,
    exact: true,
  },
  {
    path: "/access/ssh-keys",
    labelKey: "dashboard:access.tabs.sshKeys",
    icon: Fingerprint,
    exact: true,
  },
  {
    path: "/access/known-hosts",
    labelKey: "dashboard:access.tabs.knownHosts",
    icon: Server,
    exact: true,
  },
];

export function stripLangPrefix(pathname: string): string {
  const match = pathname.match(/^\/[a-z]{2}(?:-[A-Z]{2})?(\/.*)?$/i);

  if (!match) {
    return pathname;
  }

  const rest = match[1] ?? "/";

  if (rest === "" || rest === "/") {
    return "/";
  }

  return rest;
}
