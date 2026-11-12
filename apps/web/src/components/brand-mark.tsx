import { env } from "@cockpit-context/env/web";
import { cn } from "@cockpit-context/ui/lib/utils";

/** Decorative artwork; the app name remains the accessible text. */
export function BrandMark({
  className,
  size = "md",
  withName = true,
}: {
  className?: string;
  size?: "md" | "lg";
  /** Off where the name is already on screen (the header above the auth screens). */
  withName?: boolean;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <img
        src="/pwa-192x192.png"
        alt=""
        width={36}
        height={36}
        decoding="async"
        className="size-9 shrink-0"
      />
      {withName ? (
        <span
          className={cn(
            "min-w-0 truncate font-semibold tracking-tight",
            size === "lg" ? "text-xl" : "text-lg",
          )}
        >
          {env.VITE_APP_NAME}
        </span>
      ) : null}
    </span>
  );
}
