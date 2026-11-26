import { env } from "@cockpit-context/env/web";
import { Link } from "@tanstack/react-router";

import type { APP_HOME } from "@/lib/app-home";
import { APP_LOGO } from "@/lib/app-logo";

/**
 * The logo and app name at the start of both header rows (the app shell's
 * `Header` and the public `PublicHeader`), so the two can never size it
 * differently.
 *
 * The name only takes the room the rest of the row leaves it, so it is the
 * first thing to give way and the controls never run past the header's
 * trailing line, whatever the name's length, the width or the locale. Its flex
 * basis is 0 (`basis-0 grow`): it grows into what is left after the controls,
 * up to its own width (`max-w-fit`), and never below a 44px target
 * (`min-w-11`, which still shows the 32px logo). A shrink factor cannot do
 * this: CSS has no shrink order, and any factor still hands the controls a
 * fraction of a pixel. With a MainNav in the row the two share what is left.
 * The name's caps (160px, 224px from `sm:`, 320px from `lg:`) keep a long name
 * from taking the MainNav's room. A name that does not fit ends in an
 * ellipsis (the `truncate` span), and the full name is the link's `title`.
 *
 * The logo comes first (`APP_LOGO`, lib/app-logo.ts): an `<img>` with its
 * 32px box declared, so nothing moves when it loads, and the same element in
 * the loading shell, so it never pops in. Its `alt` is the app name and the
 * visible name is `aria-hidden`, so the link's accessible name is the name
 * once, not twice. It never shrinks: below the name's room the name gives
 * way. docs/ui.md § Logo slot.
 */
export function AppNameLink({ to, lang }: { to: typeof APP_HOME | "/$lang"; lang: string }) {
  const appName = env.VITE_APP_NAME;
  return (
    <Link
      to={to}
      params={{ lang }}
      title={appName}
      className="inline-flex min-h-11 min-w-11 max-w-fit grow basis-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img
        src={APP_LOGO.src}
        srcSet={APP_LOGO.srcSet}
        sizes={APP_LOGO.sizes}
        width={APP_LOGO.size}
        height={APP_LOGO.size}
        alt={appName}
        decoding="async"
        className="size-8 shrink-0"
      />
      <span
        aria-hidden="true"
        className="min-w-0 max-w-40 truncate text-lg font-semibold tracking-tight sm:max-w-56 lg:max-w-80"
      >
        {appName}
      </span>
    </Link>
  );
}
