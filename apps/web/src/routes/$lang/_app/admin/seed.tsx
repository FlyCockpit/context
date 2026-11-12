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
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Database } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import NotFoundState from "@/components/not-found-state";
import { BACK_LINK_CLASS } from "@/components/page-shell";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/admin/seed")({
  component: AdminSeed,
});

function AdminSeed() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["admin", "common"]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const {
    data: infoData,
    isPending: infoPending,
    isError: infoIsError,
    refetch: refetchInfo,
  } = useQuery({
    ...orpc.seed.info.queryOptions(),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  // The seed runs inline: the mutation resolves with its summary (or rejects
  // with its error), so there is no job to poll.
  const run = useMutation({
    ...orpc.seed.run.mutationOptions({
      onSuccess: () => {
        toast.success(t("admin:seedPage.completed"));
      },
    }),
    meta: { errorFallbackKey: "admin:seedPage.runFailed" },
  });

  // Resolve inside the gated admin layout: blocked admins must reach enrollment
  // before any admin-only seed query runs. Production renders the not-found
  // page (throwing notFound() from a component render would hit the root error
  // boundary instead).
  if (infoData?.isProduction) return <NotFoundState />;

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 space-y-6">
      <header className="space-y-2">
        <Link to="/$lang/admin" params={{ lang }} className={BACK_LINK_CLASS}>
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("admin:seedPage.back")}
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Database className="size-6" aria-hidden />
          {t("admin:seedPage.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("admin:seedPage.description")}</p>
        <p className="text-xs text-muted-foreground">{t("admin:seedPage.inlineNote")}</p>
      </header>

      {infoPending ? (
        <Skeleton className="h-40 w-full" />
      ) : infoIsError ? (
        <InlineRetry
          variant="destructive"
          onRetry={() => refetchInfo()}
          message={t("admin:seedPage.loadInfoFailed")}
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("admin:seedPage.runTitle")}</CardTitle>
              <CardDescription>{t("admin:seedPage.demoDataNote")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="destructive"
                className="min-h-[44px]"
                disabled={run.isPending}
                onClick={() => {
                  setConfirmOpen(true);
                }}
              >
                {run.isPending ? t("admin:seedPage.running") : t("admin:seedPage.runButton")}
              </Button>
              {run.isSuccess ? <SeedResult result={run.data} /> : null}
              {run.isError ? <SeedFailure message={run.error.message} /> : null}
            </CardContent>
          </Card>

          <ConfirmDeleteDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title={t("admin:seedPage.confirmTitle")}
            description={t("admin:seedPage.confirmDescription")}
            confirmToken={infoData.requiredConfirmPhrase}
            typePrompt={t("admin:seedPage.typePrompt")}
            copyAriaLabel={t("admin:seedPage.copyAria")}
            inputMode="text"
            confirmLabel={t("admin:seedPage.confirmCta")}
            pendingLabel={t("admin:seedPage.confirmPending")}
            isPending={run.isPending}
            onConfirm={(confirmValue) => {
              run.mutate({ confirm: confirmValue }, { onSuccess: () => setConfirmOpen(false) });
            }}
          />
        </>
      )}
    </div>
  );
}

function SeedResult({ result }: { result: { summary: string[]; durationMs: number } }) {
  const { t } = useTranslation("admin");
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <p className="font-medium">{t("seedPage.jobCompleteTitle")}</p>
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        {t("seedPage.jobDuration", { ms: result.durationMs })}
      </p>
      {result.summary.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("seedPage.jobEmpty")}</p>
      ) : (
        <ul className="mt-2 space-y-1 text-xs">
          {result.summary.map((line, i) => (
            <li
              key={`${i}-${line}`}
              className="rounded bg-background px-2 py-1 font-mono break-all"
            >
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SeedFailure({ message }: { message: string }) {
  const { t } = useTranslation("admin");
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <p className="font-medium text-destructive">{t("seedPage.jobFailedTitle")}</p>
      {message ? <p className="mt-1 text-xs text-destructive break-all">{message}</p> : null}
    </div>
  );
}
