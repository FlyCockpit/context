import { cn } from "@cockpit-context/ui/lib/utils";

/**
 * The logo alone, as decoration above the auth forms (the header right above
 * already names the app). The header's logo with the name is `AppNameLink`;
 * both draw the generated icons from `apps/web/assets/logo.png`. The 192px
 * install icon covers a 36px box up to 5× density. docs/ui.md § Logo slot.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/pwa-192x192.png"
      alt=""
      width={36}
      height={36}
      decoding="async"
      className={cn("size-9 shrink-0", className)}
    />
  );
}
