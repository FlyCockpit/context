import { env } from "@cockpit-context/env/web";
import { Link } from "@tanstack/react-router";

import { BrandMark } from "./brand-mark";

/**
 * The wordmark at the start of both header rows (the app shell's `Header` and
 * the public `PublicHeader`), so the two can never size it differently.
 *
 * The wordmark only takes the room the rest of the row leaves it, so it is the
 * first thing to give way and the controls never run past the header's
 * trailing line, whatever the name's length, the width or the locale. Its flex
 * basis is 0 (`basis-0 grow`): it grows into what is left after the controls,
 * up to its own width (`max-w-fit`), and never below a 44px target
 * (`min-w-11`, which still shows the 36px mark). A shrink factor cannot do
 * this: CSS has no shrink order, and any factor still hands the controls a
 * fraction of a pixel. With a MainNav in the row the two share what is left.
 * The name's caps (160px, 224px from `sm:`, 320px from `lg:`) keep a long name
 * from taking the MainNav's room. A name that does not fit ends in an
 * ellipsis (BrandMark's `truncate` span), and the full name is the link's
 * `title` and accessible name.
 */
export function AppNameLink({ to, lang }: { to: "/$lang/ongoing" | "/$lang"; lang: string }) {
  return (
    <Link
      to={to}
      params={{ lang }}
      title={env.VITE_APP_NAME}
      className="inline-flex min-h-11 min-w-11 max-w-fit grow basis-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <BrandMark nameClassName="max-w-40 sm:max-w-56 lg:max-w-80" />
    </Link>
  );
}
