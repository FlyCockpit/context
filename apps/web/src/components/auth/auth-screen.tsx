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
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  const { t } = useTranslation(["auth"]);
  return (
    <div className="relative isolate flex min-h-full min-w-0 flex-col items-center justify-center px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_60%)]"
      />
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <BrandMark size="lg" withName={false} />
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
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="text-center">
          {/* The card title is the page's heading: auth screens have no other. */}
          <CardTitle className="text-2xl text-balance">
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription className="text-pretty">{description}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-4">{children}</CardContent>
      </Card>
    </AuthScreen>
  );
}
