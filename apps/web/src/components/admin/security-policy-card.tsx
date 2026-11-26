import type { ForceTwoFactorSettingKey } from "@cockpit-context/auth/two-factor-policy";
import { buttonVariants } from "@cockpit-context/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-context/ui/components/card";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link, useParams } from "@tanstack/react-router";
import { Info, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SettingSwitchRow } from "@/components/setting-switch-row";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";

export type SecurityPolicy = {
  key: ForceTwoFactorSettingKey;
  enabled: boolean;
  title: string;
  description: string;
};

/**
 * The force-2FA policy card on /admin/settings. Each policy shows its state
 * as a labelled switch with visible "On"/"Off" text, never only through a
 * button verb. Turning a policy on needs the admin's own 2FA: that is a
 * prerequisite, not an error, so it is an info note with a link to set it
 * up, and the switch it blocks says why beside it.
 */
export function SecurityPolicyCard({
  policies,
  adminHas2FA,
  isUpdating,
  onToggle,
}: {
  policies: SecurityPolicy[];
  adminHas2FA: boolean;
  isUpdating: boolean;
  onToggle: (key: ForceTwoFactorSettingKey, newValue: "true" | "false") => void;
}) {
  const { t } = useTranslation("admin");
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-5" aria-hidden="true" />
          {t("settings.securityTitle")}
        </CardTitle>
        <CardDescription>{t("settings.securityDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!adminHas2FA && (
          <div
            role="note"
            data-slot="settings-prerequisite"
            className="flex flex-col gap-3 rounded-lg border border-state-info/40 bg-state-info-bg p-4 text-sm sm:flex-row sm:items-start"
          >
            <Info className="mt-0.5 size-4 shrink-0 text-state-info" aria-hidden="true" />
            <p className="flex-1">{t("settings.force2faAdminPrerequisite")}</p>
            <Link
              to="/$lang/settings/security"
              params={{ lang }}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "min-h-[44px] shrink-0",
              )}
            >
              {t("settings.goToSecurity")}
            </Link>
          </div>
        )}
        {policies.map((policy) => (
          <SettingSwitchRow
            key={policy.key}
            title={policy.title}
            description={policy.description}
            checked={policy.enabled}
            // Turning a policy OFF never needs the admin's own 2FA.
            disabled={!adminHas2FA && !policy.enabled}
            reason={!adminHas2FA && !policy.enabled ? t("settings.force2faNeedsOwn2fa") : null}
            updating={isUpdating}
            onCheckedChange={(checked) => onToggle(policy.key, checked ? "true" : "false")}
          />
        ))}
      </CardContent>
    </Card>
  );
}
