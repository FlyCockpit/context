import type { AppRouterClient } from "@cockpit-context/api/routers/index";
import { Button, buttonVariants } from "@cockpit-context/ui/components/button";
import { Card, CardContent } from "@cockpit-context/ui/components/card";
import { CodeSnippet } from "@cockpit-context/ui/components/code-snippet";
import { CopyField } from "@cockpit-context/ui/components/copy-field";
import { toast } from "@cockpit-context/ui/components/sileo";
import { cn } from "@cockpit-context/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { StatusPill } from "@/components/status-pill";
import { claudeOAuthCommand, codexOAuthCommand } from "@/lib/access";
import {
  defaultGettingStartedExpanded,
  gettingStartedProgress,
  hideGettingStarted,
  isGettingStartedHidden,
  subscribeGettingStartedHidden,
} from "@/lib/getting-started";

export type HomeStatus = Awaited<ReturnType<AppRouterClient["home"]["status"]>>;

const LINK_BUTTON = cn(buttonVariants({ variant: "outline", size: "touch" }), "gap-2");

/**
 * The getting-started checklist at the top of Ongoing (the signed-in home,
 * lib/app-home.ts): connect an agent, add a package, ask a question. Each
 * step's `done` comes from the server (`home.status`), never a tick by the
 * user, and every open step shows its next action inline (the connect
 * commands to copy, the Packages link, an example question). docs/ui.md
 * § Signed-in home.
 *
 * - Gone once every step is done, and hideable before that ("Hide", with an
 *   Undo toast). The hidden flag is per user (`scope` = the user id) and per
 *   browser (lib/getting-started.ts).
 * - A disclosure (`aria-expanded`): collapsed below `sm` to the title and the
 *   progress, so on a phone the live and recent conversations stay on
 *   screen; expanded from `sm` up.
 *
 * Render it only once `home.status` has loaded: it has no skeleton, so
 * mounting it with guesses would show wrong ticks and then move the page.
 */
export function GettingStarted({
  lang,
  status,
  scope,
}: {
  lang: string;
  status: HomeStatus;
  /** Whose checklist this is (the user id): the key of the hidden flag. */
  scope: string;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  // One getter for both snapshots: the app branch is client-only, and on a
  // server (no `window`) it reads "not hidden" anyway.
  const readHidden = () => isGettingStartedHidden(scope);
  const hidden = useSyncExternalStore(subscribeGettingStartedHidden, readHidden, readHidden);
  const [expanded, setExpanded] = useState(defaultGettingStartedExpanded);
  const bodyId = useId();
  const progress = gettingStartedProgress([
    { done: status.hasConnection },
    { done: status.hasPackages },
    { done: status.hasConversations },
  ]);

  if (hidden || progress.allDone) return null;

  const onCopied = () => toast.success(t("common:actions.copied"));
  const hide = () =>
    hideGettingStarted(scope, (undo) => {
      toast.message(t("dashboard:ongoing.start.hidden"), {
        action: { label: t("dashboard:ongoing.start.undo"), onClick: undo },
      });
    });

  return (
    <Card data-getting-started="" className="gap-2 py-2">
      <div className="flex min-w-0 items-start gap-2 px-2">
        {/* The accordion pattern: the heading holds the disclosure button. */}
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((open) => !open)}
            className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
                expanded && "rotate-90",
              )}
            />
            <span className="min-w-0 truncate text-lg font-medium">
              {t("dashboard:ongoing.start.title")}
            </span>
            <StatusPill tone={progress.done > 0 ? "info" : "muted"} className="shrink-0">
              {t("dashboard:ongoing.start.progress", {
                done: progress.done,
                total: progress.total,
              })}
            </StatusPill>
          </button>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="touch"
          className="shrink-0"
          aria-label={t("dashboard:ongoing.start.hideAriaLabel")}
          onClick={hide}
        >
          {t("dashboard:ongoing.start.hide")}
        </Button>
      </div>
      <CardContent id={bodyId} hidden={!expanded} className="space-y-4 pb-2">
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">
          {t("dashboard:ongoing.start.description")}
        </p>
        <ol className="flex min-w-0 flex-col">
          <Step
            index={1}
            id="connect"
            done={status.hasConnection}
            title={t("dashboard:ongoing.start.connect.title")}
            body={t("dashboard:ongoing.start.connect.body")}
          >
            <p className="text-sm font-medium">{t("dashboard:ongoing.start.connect.claudeCode")}</p>
            <CopyField
              value={claudeOAuthCommand(status.mcpUrl)}
              copyLabel={t("dashboard:ongoing.start.connect.copy")}
              onCopied={onCopied}
            />
            <p className="text-xs text-muted-foreground">
              {t("dashboard:ongoing.start.connect.authenticate")}
            </p>
            <p className="text-sm font-medium">{t("dashboard:ongoing.start.connect.codex")}</p>
            <CodeSnippet
              code={codexOAuthCommand(status.mcpUrl)}
              copyLabel={t("dashboard:ongoing.start.connect.copyCodex")}
              onCopied={onCopied}
            />
            <div className="flex flex-wrap gap-2">
              <Link to="/$lang/access/tokens" params={{ lang }} className={LINK_BUTTON}>
                {t("dashboard:ongoing.start.connect.token")}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          </Step>
          <Step
            index={2}
            id="package"
            done={status.hasPackages}
            title={t("dashboard:ongoing.start.package.title")}
            body={t("dashboard:ongoing.start.package.body")}
          >
            <div className="flex flex-wrap gap-2">
              <Link to="/$lang/packages" params={{ lang }} className={LINK_BUTTON}>
                {t("dashboard:ongoing.start.package.action")}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          </Step>
          <Step
            index={3}
            id="ask"
            done={status.hasConversations}
            last
            title={t("dashboard:ongoing.start.ask.title")}
            body={t("dashboard:ongoing.start.ask.body")}
          >
            <CopyField
              value={t("dashboard:ongoing.start.ask.example")}
              copyLabel={t("dashboard:ongoing.start.ask.copy")}
              onCopied={onCopied}
            />
          </Step>
        </ol>
      </CardContent>
    </Card>
  );
}

function Step({
  index,
  id,
  done,
  last = false,
  title,
  body,
  children,
}: {
  index: number;
  id: string;
  done: boolean;
  last?: boolean;
  title: string;
  body: string;
  children: ReactNode;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <li
      data-step={id}
      data-done={done ? "" : undefined}
      className="relative flex min-w-0 gap-4 pb-6 last:pb-0"
    >
      {last ? null : (
        <span
          aria-hidden="true"
          className="absolute top-9 bottom-1 left-[calc(1rem_-_1px)] w-px bg-border"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "relative grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold",
          done
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "border border-primary/40 bg-background text-primary-text",
        )}
      >
        {done ? <Check className="size-4" /> : index}
      </span>
      <div className="min-w-0 flex-1 space-y-3 pt-1">
        <div className="space-y-1">
          <h3 className="flex flex-wrap items-center gap-2 font-medium">
            <span className={cn(done && "text-muted-foreground")}>{title}</span>
            {done ? <StatusPill tone="good">{t("dashboard:ongoing.start.done")}</StatusPill> : null}
          </h3>
          <p className="max-w-prose text-sm text-pretty text-muted-foreground">{body}</p>
        </div>
        {done ? null : children}
      </div>
    </li>
  );
}
