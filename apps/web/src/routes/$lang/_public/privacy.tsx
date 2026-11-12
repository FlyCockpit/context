import { env } from "@cockpit-context/env/web";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import {
  conversationRetentionCopy,
  PRIVACY_SECTIONS,
  type PrivacySection,
} from "@/lib/privacy-notice";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_public/privacy")({
  head: ({ match }) => ({
    meta: [{ title: `${match.context.i18n.t("privacy:meta.title")} · ${env.VITE_APP_NAME}` }],
  }),
  component: PrivacyPage,
});

// The public privacy notice, per
// docs/product.md § Sharing and privacy
// SSR-rendered and readable without signing in. The section list is in
// lib/privacy-notice.ts and the copy in the `privacy` namespace. The operator's
// name and contact address are deploy-time config (COCKPIT_CONTEXT_OPERATOR_NAME /
// COCKPIT_CONTEXT_OPERATOR_CONTACT_EMAIL), read on the client from the public `appConfig`
// procedure; unset, the page says no contact details have been published. The
// conversation retention item states the configured
// COCKPIT_CONTEXT_CONVERSATION_RETENTION_DAYS from the same procedure.
function PrivacyPage() {
  const { t } = useTranslation(["privacy"]);
  return (
    <PageShell width="narrow" className="max-w-3xl py-10">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">{t("privacy:title")}</h1>
        <p className="text-sm text-muted-foreground">{t("privacy:updated")}</p>
        <p className="text-pretty">{t("privacy:intro")}</p>
      </header>
      {PRIVACY_SECTIONS.map((section) => (
        <NoticeSection key={section.id} section={section} />
      ))}
    </PageShell>
  );
}

function NoticeSection({ section }: { section: PrivacySection }) {
  const { t } = useTranslation(["privacy"]);
  const base = `privacy:sections.${section.id}`;
  const headingId = `privacy-${section.id}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3 border-t pt-6">
      <h2 id={headingId} className="text-xl font-semibold tracking-tight">
        {t(`${base}.title`)}
      </h2>
      {section.paragraphs.map((paragraph) => (
        <p key={paragraph} className="text-pretty">
          {t(`${base}.${paragraph}`)}
        </p>
      ))}
      {section.items.length > 0 ? (
        <dl className="space-y-3">
          {section.items.map((item) => (
            <div key={item}>
              <dt className="font-medium">{t(`${base}.items.${item}.term`)}</dt>
              <dd className="text-pretty text-muted-foreground">
                {item === section.retentionItem ? (
                  <ConfiguredRetention itemBase={`${base}.items.${item}`} />
                ) : (
                  t(`${base}.items.${item}.detail`)
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {section.note ? <p className="text-pretty">{t(`${base}.note`)}</p> : null}
      {section.contact ? <OperatorContact sectionId={section.id} kind={section.contact} /> : null}
    </section>
  );
}

/** The conversation retention this server is configured with (0 = kept until deleted). */
function ConfiguredRetention({ itemBase }: { itemBase: string }) {
  const { t } = useTranslation(["privacy"]);
  const config = useQuery(orpc.appConfig.queryOptions());
  return (
    <QueryBoundary
      query={config}
      skeleton={
        <div aria-hidden="true" className="flex flex-col gap-1.5 pt-1">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      }
      errorMessage={t(`${itemBase}.loadFailed`)}
      errorClassName="items-start py-0 text-start"
    >
      {({ conversationRetentionDays }) => {
        const copy = conversationRetentionCopy(conversationRetentionDays);
        return t(`${itemBase}.${copy.key}`, { count: copy.count });
      }}
    </QueryBoundary>
  );
}

/**
 * The operator's published identity: the name and contact address in "Who runs
 * this server", the address alone in "Your requests". Neutral text when unset.
 */
function OperatorContact({
  sectionId,
  kind,
}: {
  sectionId: string;
  kind: NonNullable<PrivacySection["contact"]>;
}) {
  const { t } = useTranslation(["privacy"]);
  const config = useQuery(orpc.appConfig.queryOptions());
  const base = `privacy:sections.${sectionId}.contact`;
  return (
    <QueryBoundary
      query={config}
      skeleton={<Skeleton aria-hidden="true" className="h-5 w-64 max-w-full" />}
      errorMessage={t(`${base}.loadFailed`)}
    >
      {({ operator }) => {
        const email = operator.contactEmail ? (
          <p className="text-pretty">
            {t(`${base}.contactLabel`)}{" "}
            <a
              href={`mailto:${operator.contactEmail}`}
              className="font-medium break-all underline underline-offset-4"
            >
              {operator.contactEmail}
            </a>
          </p>
        ) : null;
        if (kind === "requests") {
          return email ?? <p className="text-pretty">{t(`${base}.unpublished`)}</p>;
        }
        if (!operator.name && !email) {
          return <p className="text-pretty">{t(`${base}.unpublished`)}</p>;
        }
        return (
          <>
            {operator.name ? (
              <p className="text-pretty">{t(`${base}.named`, { name: operator.name })}</p>
            ) : null}
            {email ?? <p className="text-pretty">{t(`${base}.noEmail`)}</p>}
          </>
        );
      }}
    </QueryBoundary>
  );
}
