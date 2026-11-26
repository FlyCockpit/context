import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-context/ui/components/card";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { BrandMark } from "@/components/brand-mark";

/**
 * The shared frame of every signed-out screen (sign-in, sign-up, verify,
 * reset, forced 2FA, MCP sign-in and consent): the wordmark and tagline over
 * a centered column, on a soft primary-tinted backdrop that follows the theme.
 *
 * From `sm` up the column is centred in the page under the mark and tagline.
 * On phones it starts just under the header, and the mark and tagline (the
 * header right above already shows the mark; the landing page carries the
 * tagline) give their room to the form: centred, with them, the login page's
 * last line (its sign-up link) ended behind the BottomNav at 320×568.
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  const { t } = useTranslation(["auth"]);
  return (
    <div className="relative isolate flex min-h-full min-w-0 flex-col items-center justify-center px-4 py-10 max-sm:justify-start max-sm:pt-4 max-sm:pb-4">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_60%)]"
      />
      <div className="mb-6 flex flex-col items-center gap-2 text-center max-sm:hidden">
        <BrandMark />
        <p className="max-w-xs text-sm text-balance text-muted-foreground">
          {t("auth:screen.tagline")}
        </p>
      </div>
      <div className="flex w-full min-w-0 justify-center">{children}</div>
    </div>
  );
}

export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <AuthScreen>
      {/* Flat on phones, like its loading skeleton: no surface, ring, shadow or
          inner padding, so the form sits on the page's 16px text line and the
          card's own vertical padding goes to the form. Overflow stays visible
          there so the inputs' focus rings are not clipped at the edge. */}
      <Card className="w-full max-w-md shadow-sm max-sm:overflow-visible max-sm:bg-transparent max-sm:py-0 max-sm:shadow-none max-sm:ring-0">
        <CardHeader className="text-center max-sm:px-0">
          {/* The card title is the page's heading: auth screens have no other. */}
          <CardTitle className="text-2xl text-balance">
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription className="text-pretty">{description}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-4 max-sm:px-0">{children}</CardContent>
      </Card>
    </AuthScreen>
  );
}
