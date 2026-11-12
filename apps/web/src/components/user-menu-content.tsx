import { Button } from "@cockpit-context/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cockpit-context/ui/components/dropdown-menu";
import { useNavigate, useParams } from "@tanstack/react-router";
import { User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthSession } from "@/hooks/use-auth-session";
import { markExplicitSignOut } from "@/hooks/use-reload-on-identity-change";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { getNavItems, toLangRoute } from "@/lib/nav-items";

/**
 * The real Base UI account menu. Lazy-loaded by `user-menu.tsx` on first
 * interaction so the shared Base UI overlay chunk stays off the eager bundle
 * (UserMenu mounts in the root on every page). It mounts `defaultOpen` so the
 * click that triggered the load opens the menu immediately — no effect, no
 * second click. Only rendered when a session is present.
 */
export default function UserMenuContent() {
  const navigate = useNavigate();
  // `strict: false` so the menu renders under both prefixed and (briefly) the
  // top-level `/` redirect route without throwing.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const authSession = useAuthSession();
  const { t } = useTranslation("nav");

  // The shell only renders this once a session exists; guard defensively so a
  // session-expiry race can't dereference a null user.
  if (authSession.state.status !== "authenticated") return null;
  const session = authSession.state.session;

  const userMenuItems = getNavItems({
    placement: "userMenu",
    isAuthenticated: true,
    role: session.user.role,
  });

  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger
        aria-label={t("userMenu.open")}
        render={
          <Button variant="outline" size="touch" className="w-11 px-0! md:w-auto md:px-3.5!" />
        }
      >
        <User className="size-4 md:hidden" aria-hidden="true" />
        <span className="hidden max-w-40 truncate md:inline">{session.user.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56 bg-card">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="space-y-0.5">
            <span className="block text-muted-foreground">{t("userMenu.myAccount")}</span>
            <span className="block truncate text-foreground">{session.user.name}</span>
            {session.user.email ? (
              <span className="block truncate font-normal">{session.user.email}</span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {userMenuItems.map((item) => (
            <DropdownMenuItem
              key={item.id}
              onClick={() => navigate({ to: toLangRoute(item.path), params: { lang } })}
            >
              <item.icon className="mr-2 size-4" />
              {t(item.labelKey)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={async () => {
              // Dynamic import keeps the sign-out path out of the menu chunk's
              // critical path; the auth client is already warm once the menu
              // is reachable for a signed-in user.
              const { authClient } = await import("@/lib/auth-client");
              const undoSignOutMark = markExplicitSignOut();
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    window.location.assign(`/${lang}/login`);
                  },
                  onError: undoSignOutMark,
                },
              });
            }}
          >
            {t("userMenu.signOut")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
