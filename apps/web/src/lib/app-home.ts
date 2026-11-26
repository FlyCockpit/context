/**
 * The signed-in home: where a signed-in user lands when they open the app,
 * finish signing in, click the app name in the header, or visit the public
 * landing page (`/$lang/`, which forwards them here).
 *
 * The home is the app's main list, not a stats page. In Context the recurring
 * object is the conversation (agents ask, people watch, steer and stop), so
 * the home is Ongoing: the getting-started checklist until setup is done, then
 * the live and recent conversations. docs/ui.md § Signed-in home.
 *
 * This is the one place to change it. The target must be a route under the
 * `_auth` gate (`routes/$lang/_app/_auth/`), so an expired session still falls
 * through to the login page. `/$lang/dashboard` forwards here
 * (`routes/$lang/dashboard.tsx`).
 */
export const APP_HOME = "/$lang/ongoing" as const;

/** {@link APP_HOME} as a concrete href for one locale, e.g. `/en-US/ongoing`. */
export function appHomeHref(lang: string): string {
  return APP_HOME.replace("$lang", lang);
}
