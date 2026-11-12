import { resolveSignupOpen, SIGNUP_OPEN_SETTING_KEY } from "@cockpit-context/auth/signup-policy";
import {
  type ForceTwoFactorSettingKey,
  isForcedTwoFactorEnabled,
} from "@cockpit-context/auth/two-factor-policy";
import { Button } from "@cockpit-context/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-context/ui/components/card";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { Braces, Cpu, Gauge, Lock, Shield, Timer, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { StatusPill } from "@/components/status-pill";
import { formatSeconds, type RuntimeConfig } from "@/lib/admin";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/admin/settings")({
  component: AdminSettings,
});

function AdminSettings() {
  const { session } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const {
    data: appSettingsData,
    isPending: appSettingsPending,
    isError: appSettingsIsError,
    refetch: refetchAppSettings,
  } = useQuery(orpc.settings.getAll.queryOptions());
  const {
    data: setupStatusData,
    isPending: setupStatusPending,
    isError: setupStatusIsError,
    refetch: refetchSetupStatus,
  } = useQuery(orpc.settings.adminSetupStatus.queryOptions());
  const adminHas2FA = session.user.twoFactorEnabled === true;
  const { t } = useTranslation(["admin", "common"]);

  const updateSetting = useMutation({
    ...orpc.settings.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.settings.key() });
        // The public sign-up surfaces read the effective value from appConfig.
        queryClient.invalidateQueries({ queryKey: orpc.appConfig.key() });
      },
    }),
    meta: { errorFallbackKey: "admin:settings.updateFailed" },
  });

  // `isForcedTwoFactorEnabled` below resolves an ABSENT row to the shipped
  // default (`FORCE_2FA_DEFAULTS`), so the card shows the policy actually in
  // force — "Required" for admins before anyone has ever written the row,
  // matching what the server gates enforce.
  return (
    <PageShell width="narrow">
      <PageHeader title={t("admin:settings.title")} description={t("admin:settings.description")} />

      {appSettingsPending || setupStatusPending ? (
        <SettingsSkeleton />
      ) : appSettingsIsError || setupStatusIsError ? (
        <Card>
          <CardContent>
            <InlineRetry
              className="py-12"
              message={t("admin:settings.loadFailed")}
              onRetry={() => {
                refetchAppSettings();
                refetchSetupStatus();
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <SignupCard
            envEnabled={setupStatusData.signupEnvEnabled}
            open={resolveSignupOpen(
              setupStatusData.signupEnvEnabled,
              appSettingsData[SIGNUP_OPEN_SETTING_KEY],
            )}
            isUpdating={updateSetting.isPending}
            onToggle={(newValue) => {
              updateSetting.mutate(
                { key: SIGNUP_OPEN_SETTING_KEY, value: newValue },
                {
                  onSuccess: () => {
                    toast.success(
                      newValue === "true"
                        ? t("admin:settings.signupOpened")
                        : t("admin:settings.signupClosed"),
                    );
                  },
                },
              );
            }}
          />
          <SecurityPolicyCard
            policies={[
              {
                key: "force2faInternalUsers",
                enabled: isForcedTwoFactorEnabled(
                  "force2faInternalUsers",
                  appSettingsData.force2faInternalUsers,
                ),
                title: t("admin:settings.force2faInternalTitle"),
                description: t("admin:settings.force2faInternalDescription"),
              },
              {
                key: "force2faPublicUsers",
                enabled: isForcedTwoFactorEnabled(
                  "force2faPublicUsers",
                  appSettingsData.force2faPublicUsers,
                ),
                title: t("admin:settings.force2faPublicTitle"),
                description: t("admin:settings.force2faPublicDescription"),
              },
            ]}
            adminHas2FA={adminHas2FA}
            isUpdating={updateSetting.isPending}
            onToggle={(key, newValue) => {
              updateSetting.mutate(
                { key, value: newValue },
                {
                  onSuccess: () => {
                    toast.success(successMessageForForceTwoFactor(t, key, newValue));
                  },
                },
              );
            }}
          />
        </>
      )}
      <RuntimeConfigSection />
    </PageShell>
  );
}

function SignupCard({
  envEnabled,
  open,
  isUpdating,
  onToggle,
}: {
  envEnabled: boolean;
  open: boolean;
  isUpdating: boolean;
  onToggle: (newValue: "true" | "false") => void;
}) {
  const { t } = useTranslation("admin");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="size-5" />
          {t("settings.signupTitle")}
        </CardTitle>
        <CardDescription>{t("settings.signupDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {envEnabled ? t("settings.signupEnvEnabled") : t("settings.signupEnvDisabled")}
        </p>
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="font-medium">
              {t("settings.signupOpenTitle")}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {open ? t("settings.signupStatusOpen") : t("settings.signupStatusClosed")}
              </span>
            </p>
            <p className="text-sm text-muted-foreground">{t("settings.signupOpenDescription")}</p>
          </div>
          <Button
            variant={open ? "destructive" : "default"}
            size="touch"
            disabled={!envEnabled || isUpdating}
            onClick={() => onToggle(open ? "false" : "true")}
          >
            {isUpdating
              ? t("settings.updating")
              : open
                ? t("settings.signupCloseAction")
                : t("settings.signupOpenAction")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SecurityPolicyCard({
  policies,
  adminHas2FA,
  isUpdating,
  onToggle,
}: {
  policies: Array<{
    key: ForceTwoFactorSettingKey;
    enabled: boolean;
    title: string;
    description: string;
  }>;
  adminHas2FA: boolean;
  isUpdating: boolean;
  onToggle: (key: ForceTwoFactorSettingKey, newValue: "true" | "false") => void;
}) {
  const { t } = useTranslation("admin");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-5" />
          {t("settings.securityTitle")}
        </CardTitle>
        <CardDescription>{t("settings.securityDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!adminHas2FA && (
          <p className="text-sm text-destructive">{t("settings.force2faAdminWarning")}</p>
        )}
        {policies.map((policy) => (
          <div
            key={policy.key}
            className="flex items-start justify-between gap-4 rounded-lg border p-4"
          >
            <div className="space-y-1">
              <p className="font-medium">{policy.title}</p>
              <p className="text-sm text-muted-foreground">{policy.description}</p>
            </div>
            <Button
              variant={policy.enabled ? "destructive" : "default"}
              size="touch"
              disabled={(!adminHas2FA && !policy.enabled) || isUpdating}
              onClick={() => onToggle(policy.key, policy.enabled ? "false" : "true")}
            >
              {isUpdating
                ? t("settings.updating")
                : policy.enabled
                  ? t("settings.disable")
                  : t("settings.enable")}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Read-only effective configuration (`settings.runtimeConfig`): whether the
 * model provider, email and off-site backups are configured, the model names, and the COCKPIT_CONTEXT_*
 * limits after defaults. Changing any of them is an environment edit and a
 * restart, so the page names each variable.
 */
function RuntimeConfigSection() {
  const { t } = useTranslation("admin");
  const config = useQuery({
    ...orpc.settings.runtimeConfig.queryOptions(),
    refetchInterval: 5_000,
  });
  return (
    <QueryBoundary
      query={config}
      skeleton={<RuntimeConfigSkeleton />}
      errorMessage={t("settings.runtime.loadFailed")}
      errorClassName="rounded-xl border py-12"
    >
      {(data) => (
        <>
          <ServicesCard config={data} />
          <PrivacyCard config={data} />
          <LanguageServersCard config={data} />
          <LimitsCard limits={data.limits} />
          <RateLimitsCard budgets={data.rateLimits} />
        </>
      )}
    </QueryBoundary>
  );
}

function ConfiguredPill({ configured }: { configured: boolean }) {
  const { t } = useTranslation("admin");
  return (
    <StatusPill tone={configured ? "good" : "bad"}>
      {configured ? t("settings.runtime.configured") : t("settings.runtime.notConfigured")}
    </StatusPill>
  );
}

function ConfigRow({
  label,
  envName,
  children,
}: {
  label: string;
  /** The env var behind the value; omitted for what the host reports. */
  envName?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {envName ? (
          <code className="block truncate font-mono text-xs text-muted-foreground">{envName}</code>
        ) : null}
      </dt>
      <dd className="min-w-0 text-sm sm:text-end">{children}</dd>
    </div>
  );
}

function ServicesCard({ config }: { config: RuntimeConfig }) {
  const { t } = useTranslation("admin");
  const { openRouter } = config;
  const modelReady = openRouter.apiKeyConfigured && openRouter.model !== null;
  const notSet = <span className="text-muted-foreground">{t("settings.runtime.notSet")}</span>;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-5" aria-hidden="true" />
          {t("settings.runtime.servicesTitle")}
        </CardTitle>
        <CardDescription>{t("settings.runtime.servicesDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {modelReady ? null : (
          <p className="text-sm text-destructive">{t("settings.runtime.modelMissing")}</p>
        )}
        <dl className="divide-y">
          <ConfigRow label={t("settings.runtime.openRouter")} envName="OPENROUTER_API_KEY">
            <ConfiguredPill configured={openRouter.apiKeyConfigured} />
          </ConfigRow>
          <ConfigRow label={t("settings.runtime.model")} envName="COCKPIT_CONTEXT_MODEL">
            {openRouter.model ? (
              <code className="font-mono text-xs break-all">{openRouter.model}</code>
            ) : (
              notSet
            )}
          </ConfigRow>
          <ConfigRow
            label={t("settings.runtime.helperModel")}
            envName="COCKPIT_CONTEXT_HELPER_MODEL"
          >
            {openRouter.helperModel ? (
              <code className="font-mono text-xs break-all">{openRouter.helperModel}</code>
            ) : (
              notSet
            )}
          </ConfigRow>
          <ConfigRow label={t("settings.runtime.modelApi")} envName="COCKPIT_CONTEXT_MODEL_API">
            <code className="font-mono text-xs">{openRouter.api}</code>
          </ConfigRow>
          {openRouter.customEndpoint ? (
            <ConfigRow
              label={t("settings.runtime.customEndpoint")}
              envName="COCKPIT_CONTEXT_OPENROUTER_BASE_URL"
            >
              <StatusPill tone="info">{t("settings.runtime.customEndpointOn")}</StatusPill>
            </ConfigRow>
          ) : null}
          <ConfigRow label={t("settings.runtime.email")} envName="SMTP_HOST, SMTP_FROM">
            <ConfiguredPill configured={config.emailConfigured} />
          </ConfigRow>
          <ConfigRow
            label={t("settings.runtime.backups")}
            envName="BACKUP_S3_*, BACKUP_MONITOR_S3_*"
          >
            <ConfiguredPill configured={config.backupsConfigured} />
          </ConfigRow>
        </dl>
        {config.emailConfigured ? null : (
          <p className="text-sm text-muted-foreground">{t("settings.runtime.emailMissing")}</p>
        )}
        <p
          className={
            config.backupsConfigured ? "text-sm text-muted-foreground" : "text-sm text-destructive"
          }
        >
          {config.backupsConfigured
            ? t("settings.runtime.backupsConfiguredNote")
            : t("settings.runtime.backupsMissing")}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Conversation retention and the operator identity the public privacy notice
 * shows (COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS, COCKPIT_CONTEXT_OPERATOR_*). An unset operator
 * value is flagged: the notice then says no contact details were published.
 */
function PrivacyCard({ config }: { config: RuntimeConfig }) {
  const { t, i18n } = useTranslation("admin");
  const { operator, conversationRetentionDays: days } = config;
  const notSet = <StatusPill tone="busy">{t("settings.runtime.notSet")}</StatusPill>;
  const operatorIncomplete = !operator.name || !operator.contactEmail;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="size-5" aria-hidden="true" />
          {t("settings.runtime.privacyTitle")}
        </CardTitle>
        <CardDescription>{t("settings.runtime.privacyDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="divide-y">
          <ConfigRow
            label={t("settings.runtime.conversationRetention")}
            envName="COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS"
          >
            <span className="tabular-nums">
              {days > 0
                ? t("settings.runtime.retentionDays", {
                    count: days,
                    value: new Intl.NumberFormat(i18n.language).format(days),
                  })
                : t("settings.runtime.retentionOff")}
            </span>
          </ConfigRow>
          <ConfigRow
            label={t("settings.runtime.operatorName")}
            envName="COCKPIT_CONTEXT_OPERATOR_NAME"
          >
            {operator.name ? <span className="break-words">{operator.name}</span> : notSet}
          </ConfigRow>
          <ConfigRow
            label={t("settings.runtime.operatorContact")}
            envName="COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL"
          >
            {operator.contactEmail ? (
              <span className="break-all">{operator.contactEmail}</span>
            ) : (
              notSet
            )}
          </ConfigRow>
        </dl>
        {operatorIncomplete ? (
          <p className="text-sm text-muted-foreground">{t("settings.runtime.operatorMissing")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Whether the agent gets the LSP tools and how the language servers are
 * confined (COCKPIT_CONTEXT_LSP_SANDBOX): the mechanism (Landlock), the kernel's ABI and
 * which protections it enforces. A required sandbox that cannot run disables
 * the tools; the card shows the helper's own message so the operator can fix
 * the host (docs/deploy.md).
 */
function LanguageServersCard({ config }: { config: RuntimeConfig }) {
  const { t, i18n } = useTranslation("admin");
  const { lsp, limits } = config;
  const { sandbox } = lsp;
  const pill =
    sandbox.mode === "landlock" ? (
      <StatusPill tone="good">
        {t("settings.runtime.lsp.sandboxOn", { abi: sandbox.abi })}
      </StatusPill>
    ) : sandbox.mode === "off" ? (
      <StatusPill tone="busy">{t("settings.runtime.lsp.sandboxOff")}</StatusPill>
    ) : sandbox.mode === "probing" ? (
      <StatusPill tone="busy">{t("settings.runtime.lsp.sandboxProbing")}</StatusPill>
    ) : (
      <StatusPill tone="bad">{t("settings.runtime.lsp.sandboxUnavailable")}</StatusPill>
    );
  const unavailableMessage =
    sandbox.mode !== "unavailable"
      ? null
      : sandbox.reason === "missing"
        ? t("settings.runtime.lsp.unavailableMissing")
        : sandbox.reason === "unsupported"
          ? t("settings.runtime.lsp.unavailableUnsupported")
          : t("settings.runtime.lsp.unavailableFailed");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Braces className="size-5" aria-hidden="true" />
          {t("settings.runtime.lsp.title")}
        </CardTitle>
        <CardDescription>{t("settings.runtime.lsp.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="divide-y">
          <ConfigRow
            label={t("settings.runtime.lsp.tools")}
            envName="COCKPIT_CONTEXT_LSP_MAX_SERVERS"
          >
            <StatusPill tone={lsp.enabled ? "good" : "muted"}>
              {lsp.enabled ? t("settings.runtime.lsp.toolsOn") : t("settings.runtime.lsp.toolsOff")}
            </StatusPill>
          </ConfigRow>
          <ConfigRow
            label={t("settings.runtime.lsp.sandbox")}
            envName="COCKPIT_CONTEXT_LSP_SANDBOX"
          >
            {pill}
          </ConfigRow>
          {sandbox.mode !== "off" && sandbox.checkedAt ? (
            <ConfigRow label={t("settings.runtime.lsp.checkedAt")}>
              <time dateTime={sandbox.checkedAt}>
                {new Date(sandbox.checkedAt).toLocaleString(i18n.language)}
              </time>
            </ConfigRow>
          ) : null}
          {sandbox.mode === "probing" ? (
            <ConfigRow label={t("settings.runtime.lsp.probeStarted")}>
              <time dateTime={sandbox.since}>
                {new Date(sandbox.since).toLocaleString(i18n.language)}
              </time>
            </ConfigRow>
          ) : null}
          {sandbox.mode === "unavailable" && sandbox.retryAt ? (
            <ConfigRow label={t("settings.runtime.lsp.retryAt")}>
              <time dateTime={sandbox.retryAt}>
                {new Date(sandbox.retryAt).toLocaleString(i18n.language)}
              </time>
            </ConfigRow>
          ) : null}
          {sandbox.mode === "landlock" ? (
            <>
              <ConfigRow label={t("settings.runtime.lsp.filesystem")}>
                <StatusPill tone="good">{t("settings.runtime.lsp.filesystemOn")}</StatusPill>
              </ConfigRow>
              <ConfigRow label={t("settings.runtime.lsp.tcp")}>
                <StatusPill tone={sandbox.tcp ? "good" : "muted"}>
                  {sandbox.tcp ? t("settings.runtime.lsp.tcpOn") : t("settings.runtime.lsp.tcpOff")}
                </StatusPill>
              </ConfigRow>
              <ConfigRow label={t("settings.runtime.lsp.scoping")}>
                <StatusPill tone={sandbox.scoping ? "good" : "muted"}>
                  {sandbox.scoping
                    ? t("settings.runtime.lsp.scopingOn")
                    : t("settings.runtime.lsp.scopingOff")}
                </StatusPill>
              </ConfigRow>
            </>
          ) : null}
        </dl>
        {sandbox.mode === "unavailable" ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{unavailableMessage}</p>
            <code className="block font-mono text-xs break-words text-muted-foreground">
              {sandbox.detail}
            </code>
          </div>
        ) : null}
        {sandbox.mode === "off" ? (
          <p className="text-sm text-destructive">{t("settings.runtime.lsp.offWarning")}</p>
        ) : null}
        {limits.lspMaxServers === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.runtime.lsp.disabledByCap")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LimitsCard({ limits }: { limits: RuntimeConfig["limits"] }) {
  const { t, i18n } = useTranslation("admin");
  const number = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
  const seconds = (value: number) => formatSeconds(value, i18n.language);
  const rows: Array<{ key: string; envName: string; value: string }> = [
    {
      key: "maxStorage",
      envName: "COCKPIT_CONTEXT_MAX_STORAGE_GB",
      // Decimal gigabytes, as packages/repos/src/config.ts counts them.
      value: t("settings.runtime.gigabytes", {
        value: number(limits.maxStorageGb),
        bytes: number(Math.floor(limits.maxStorageGb * 1e9)),
      }),
    },
    {
      key: "maxIterations",
      envName: "COCKPIT_CONTEXT_MAX_ITERATIONS",
      value: number(limits.maxIterations),
    },
    {
      key: "runTimeout",
      envName: "COCKPIT_CONTEXT_RUN_TIMEOUT_SECONDS",
      value: seconds(limits.runTimeoutSeconds),
    },
    {
      key: "modelStall",
      envName: "COCKPIT_CONTEXT_MODEL_STALL_SECONDS",
      value: seconds(limits.modelStallSeconds),
    },
    {
      key: "maxConcurrentRuns",
      envName: "COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS",
      value: number(limits.maxConcurrentRuns),
    },
    {
      key: "maxConcurrentRunsPerUser",
      envName: "COCKPIT_CONTEXT_MAX_CONCURRENT_RUNS_PER_USER",
      value: number(limits.maxConcurrentRunsPerUser),
    },
    {
      key: "mcpWait",
      envName: "COCKPIT_CONTEXT_MCP_WAIT_SECONDS",
      value: seconds(limits.mcpWaitSeconds),
    },
    {
      key: "fetchInterval",
      envName: "COCKPIT_CONTEXT_FETCH_INTERVAL_SECONDS",
      value: seconds(limits.fetchIntervalSeconds),
    },
    {
      key: "lspIdle",
      envName: "COCKPIT_CONTEXT_LSP_IDLE_SECONDS",
      value: seconds(limits.lspIdleSeconds),
    },
    {
      key: "lspMaxServers",
      envName: "COCKPIT_CONTEXT_LSP_MAX_SERVERS",
      value:
        limits.lspMaxServers === 0
          ? t("settings.runtime.lspDisabled")
          : number(limits.lspMaxServers),
    },
    {
      key: "maxMcpResultWaitsPerUser",
      envName: "COCKPIT_CONTEXT_MAX_MCP_RESULT_WAITS_PER_USER",
      value: number(limits.maxMcpResultWaitsPerUser),
    },
    {
      key: "maxLiveStreamsPerUser",
      envName: "COCKPIT_CONTEXT_MAX_LIVE_STREAMS_PER_USER",
      value: number(limits.maxLiveStreamsPerUser),
    },
    {
      key: "maxPendingProposalsPerUser",
      envName: "COCKPIT_CONTEXT_MAX_PENDING_PROPOSALS_PER_USER",
      value: number(limits.maxPendingProposalsPerUser),
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-5" aria-hidden="true" />
          {t("settings.runtime.limitsTitle")}
        </CardTitle>
        <CardDescription>{t("settings.runtime.limitsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          {rows.map((row) => (
            <ConfigRow
              key={row.key}
              label={t(`settings.runtime.limits.${row.key}`)}
              envName={row.envName}
            >
              <span className="tabular-nums">{row.value}</span>
            </ConfigRow>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * Cockpit Context's rate budgets after defaults (`COCKPIT_CONTEXT_<WHAT>_PER_<WINDOW>`): the count
 * comes from the environment, the window is fixed and named in the variable.
 * Read-only; no budget can be turned off.
 */
function RateLimitsCard({ budgets }: { budgets: RuntimeConfig["rateLimits"] }) {
  const { t, i18n } = useTranslation("admin");
  const number = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
  const windowLabel = (seconds: number) =>
    seconds % 3600 === 0
      ? t("settings.runtime.rateWindow.hour", { count: seconds / 3600 })
      : seconds % 60 === 0
        ? t("settings.runtime.rateWindow.minute", { count: seconds / 60 })
        : t("settings.runtime.rateWindow.second", { count: seconds });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Timer className="size-5" aria-hidden="true" />
          {t("settings.runtime.rateLimitsTitle")}
        </CardTitle>
        <CardDescription>{t("settings.runtime.rateLimitsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          {budgets.map((budget) => (
            <ConfigRow
              key={budget.id}
              label={t(`settings.runtime.rateLimits.${budget.id}`)}
              envName={budget.envKey}
            >
              <span className="block tabular-nums">
                {t("settings.runtime.rateBudget", {
                  points: number(budget.points),
                  window: windowLabel(budget.windowSeconds),
                })}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t(`settings.runtime.rateKeyedOn.${budget.keyedOn}`)}
              </span>
            </ConfigRow>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function RuntimeConfigSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </CardHeader>
      <CardContent className="divide-y">
        {["a", "b", "c", "d"].map((row) => (
          <div key={row} className="flex items-center justify-between gap-4 py-3">
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function successMessageForForceTwoFactor(
  t: TFunction<["admin", "common"]>,
  key: ForceTwoFactorSettingKey,
  value: "true" | "false",
): string {
  if (key === "force2faInternalUsers") {
    return value === "true"
      ? t("admin:settings.force2faInternalEnabled")
      : t("admin:settings.force2faInternalDisabled");
  }
  return value === "true"
    ? t("admin:settings.force2faPublicEnabled")
    : t("admin:settings.force2faPublicDisabled");
}

function SettingsSkeleton() {
  const { t } = useTranslation("admin");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-5" />
          <span className="sr-only">{t("settings.securityTitle")}</span>
          <Skeleton className="h-5 w-32" />
        </CardTitle>
        <CardDescription>
          <Skeleton className="h-4 w-64" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {["internal", "public"].map((policy) => (
          <div
            key={policy}
            className="flex items-start justify-between gap-4 rounded-lg border p-4"
          >
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-4 w-full max-w-md" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            <Skeleton className="h-9 w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
