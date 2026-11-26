import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-context/ui/components/card";
import { Input } from "@cockpit-context/ui/components/input";
import { Label } from "@cockpit-context/ui/components/label";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { TextField } from "@cockpit-context/ui/components/text-field";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { SettingSwitchRow } from "@/components/setting-switch-row";
import { authClient } from "@/lib/auth-client";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/settings/")({
  staticData: { pendingShape: "form" },
  component: ProfileSettings,
});

function buildProfileSchema() {
  return z.object({
    name: z.string().min(2),
  });
}

function hasAdminRole(role: string | null | undefined): boolean {
  return (role ?? "")
    .split(",")
    .map((part) => part.trim())
    .includes("admin");
}

function ProfileSettings() {
  const { session } = Route.useRouteContext();
  const { lang } = Route.useParams();
  const { t } = useTranslation(["settings", "auth", "common", "privacy"]);
  const queryClient = useQueryClient();
  const isAdmin = hasAdminRole(session.user.role);
  const {
    data: notificationPrefsData,
    isPending: notificationPrefsPending,
    isError: notificationPrefsError,
    refetch: refetchNotificationPrefs,
  } = useQuery({
    ...orpc.settings.myNotificationPreferences.queryOptions(),
    enabled: isAdmin,
  });
  const updateNotificationPrefs = useMutation({
    ...orpc.settings.updateMyNotificationPreferences.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: orpc.settings.myNotificationPreferences.queryKey(),
        });
        toast.success(t("settings:profile.notificationsSaved"));
      },
    }),
    meta: { errorFallbackKey: "settings:profile.notificationsSaveError" },
  });

  const form = useForm({
    defaultValues: {
      name: session.user.name || "",
    },
    onSubmit: async ({ value }) => {
      const result = await authClient.updateUser({
        name: value.name,
      });
      if (result.error) {
        console.error("[settings.updateUser]", result.error);
        toast.error(friendly(result.error, t("settings:profile.saveError")));
        return;
      }
      toast.success(t("settings:profile.saved"));
    },
    validators: {
      onSubmit: buildProfileSchema(),
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          {/* Card titles are the sections' h2s, under the layout's h1. */}
          <CardTitle>
            <h2>{t("settings:profile.title")}</h2>
          </CardTitle>
          <CardDescription>{t("settings:profile.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="profile-email">{t("auth:fields.email")}</Label>
              <Input
                id="profile-email"
                autoComplete="email"
                value={session.user.email}
                disabled
                aria-describedby="profile-email-hint"
              />
              <p id="profile-email-hint" className="text-xs text-muted-foreground">
                {t("settings:profile.emailReadonly")}
              </p>
            </div>

            <form.Field name="name">
              {(field) => (
                <TextField
                  field={field}
                  label={t("auth:fields.name")}
                  inputMode="text"
                  autoComplete="name"
                />
              )}
            </form.Field>

            <form.Subscribe
              selector={(state) => ({
                canSubmit: state.canSubmit,
                isSubmitting: state.isSubmitting,
              })}
            >
              {({ canSubmit, isSubmitting }) => (
                <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? t("common:actions.saving") : t("common:actions.saveChanges")}
                </Button>
              )}
            </form.Subscribe>
          </form>
        </CardContent>
      </Card>

      {isAdmin ? (
        // Saved at once, so it sits outside the profile form and its Save button.
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="flex items-center gap-2">
                <Mail className="size-5" aria-hidden="true" />
                {t("settings:emailAlerts.title")}
              </h2>
            </CardTitle>
            <CardDescription>{t("settings:emailAlerts.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {notificationPrefsError ? (
              <InlineRetry
                message={t("settings:profile.notificationsLoadError")}
                onRetry={() => refetchNotificationPrefs()}
              />
            ) : notificationPrefsPending ? (
              <Skeleton className="h-24 w-full rounded-lg" />
            ) : (
              <SettingSwitchRow
                title={t("settings:profile.operationalAlerts")}
                description={t("settings:profile.operationalAlertsDescription")}
                checked={notificationPrefsData.operationalAlerts}
                updating={updateNotificationPrefs.isPending}
                onCheckedChange={(checked) =>
                  updateNotificationPrefs.mutate({ operationalAlerts: checked })
                }
              />
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("privacy:settingsTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("privacy:settingsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to="/$lang/privacy"
            params={{ lang }}
            className={cn(buttonVariants({ variant: "outline", size: "touch" }))}
          >
            {t("privacy:title")}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
