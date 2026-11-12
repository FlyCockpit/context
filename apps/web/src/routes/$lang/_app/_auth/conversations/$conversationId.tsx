import { buttonVariants } from "@cockpit-context/ui/components/button";
import { toast } from "@cockpit-context/ui/components/sileo";
import { Skeleton } from "@cockpit-context/ui/components/skeleton";
import { cn } from "@cockpit-context/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowDownToLine, ArrowLeft, MessagesSquare } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Composer } from "@/components/conversations/composer";
import { ConversationHeader } from "@/components/conversations/conversation-header";
import { TranscriptBlocks } from "@/components/conversations/transcript";
import { EmptyState } from "@/components/empty-state";
import { InlineRetry } from "@/components/inline-retry";
import { useConversationWatch } from "@/hooks/use-conversation-watch";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import {
  buildTranscript,
  type ConversationViewState,
  composerMode,
  isActive,
  latestMainRun,
  transcriptActivityKey,
} from "@/lib/conversations";
import { errorCode, errorReason, friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/conversations/$conversationId")({
  component: ConversationPage,
});

/**
 * One conversation, live (docs/product.md): the header, the
 * streaming transcript with tool calls and helper panels, and the composer
 * that steers a live run or asks a follow-up. The page owns the full height
 * of the shell's scroller: the transcript scrolls on its own between the
 * header and the composer.
 */
function ConversationPage() {
  const { lang, conversationId } = Route.useParams();
  // A different conversation starts from scratch (state, scroll, draft).
  return <ConversationView key={conversationId} lang={lang} conversationId={conversationId} />;
}

function ConversationView({ lang, conversationId }: { lang: string; conversationId: string }) {
  const { t } = useTranslation(["dashboard"]);
  const watch = useConversationWatch(conversationId);
  const { state } = watch;
  const blocks = useMemo(() => (state ? buildTranscript(state) : []), [state]);
  const scroll = useStickToBottom(transcriptActivityKey(state), conversationId);

  if (!state) {
    if (watch.status === "failed") {
      return (
        <div className="container mx-auto max-w-4xl px-4 py-8">
          {errorCode(watch.failure) === "NOT_FOUND" ? (
            <EmptyState
              icon={MessagesSquare}
              title={t("dashboard:conversation.notFound.title")}
              description={t("dashboard:conversation.notFound.description")}
              action={
                <Link
                  to="/$lang/conversations"
                  params={{ lang }}
                  className={cn(buttonVariants({ variant: "outline", size: "touch" }), "gap-2")}
                >
                  <ArrowLeft aria-hidden="true" className="size-4" />
                  {t("dashboard:pages.conversation.back")}
                </Link>
              }
            />
          ) : (
            <InlineRetry
              className="py-12"
              message={t("dashboard:conversation.loadFailed")}
              onRetry={watch.resubscribe}
            />
          )}
        </div>
      );
    }
    return <ConversationSkeleton />;
  }

  const askedBy =
    state.conversation.origin === "mcp"
      ? (state.conversation.mcpConnectionLabel ?? t("dashboard:origin.mcp"))
      : null;

  return (
    <div
      data-pull-to-refresh="off"
      className="mx-auto flex h-[100cqh] w-full max-w-4xl min-w-0 flex-col"
    >
      <div className="shrink-0 border-b px-4 pt-2 pb-3">
        <ConversationHeader
          state={state}
          lang={lang}
          reconnecting={watch.status === "reconnecting"}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        <section
          ref={scroll.containerRef}
          onScroll={scroll.onScroll}
          onPointerDownCapture={scroll.pauseFollowing}
          aria-label={t("dashboard:conversation.transcript.label")}
          // The transcript scrolls on its own, so keyboard users must be able to focus it.
          tabIndex={0}
          className="h-full min-w-0 overflow-y-auto overflow-x-clip overscroll-contain px-4 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [scrollbar-gutter:stable]"
        >
          {state.truncated ? (
            <p className="mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {t("dashboard:conversation.truncated")}
            </p>
          ) : null}
          <TranscriptBlocks blocks={blocks} askedBy={askedBy} />
        </section>
        {scroll.following ? null : (
          <button
            type="button"
            onClick={scroll.jumpToLatest}
            className={cn(
              "absolute start-1/2 bottom-3 flex min-h-[44px] max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border bg-background/95 px-4 text-sm shadow-md backdrop-blur transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rtl:translate-x-1/2",
              scroll.hasUnseenActivity && "border-primary/50 text-primary-text",
            )}
          >
            <ArrowDownToLine aria-hidden="true" className="size-4" />
            {scroll.hasUnseenActivity
              ? t("dashboard:conversation.jumpToLatestNew")
              : t("dashboard:conversation.jumpToLatest")}
          </button>
        )}
      </div>
      <div className="shrink-0 border-t bg-background px-4 pt-3 pb-3">
        <ConversationComposer state={state} conversationId={conversationId} />
      </div>
    </div>
  );
}

function ConversationComposer({
  state,
  conversationId,
}: {
  state: ConversationViewState;
  conversationId: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const mode = composerMode(state);
  const main = latestMainRun(state);
  const live = main !== null && isActive(main.status);
  const refreshLists = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.conversations.list.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.home.key() });
  };

  const steer = useMutation({
    ...orpc.conversations.steer.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const send = useMutation({
    ...orpc.conversations.send.mutationOptions({ onSuccess: refreshLists }),
    meta: { skipGlobalErrorToast: true },
  });
  const stop = useMutation({
    ...orpc.conversations.stop.mutationOptions({
      onSuccess: (result) => {
        refreshLists();
        if (!result.stopped) toast.info(t("dashboard:conversation.composer.nothingToStop"));
      },
    }),
  });

  const onSubmit = async (text: string) => {
    try {
      if (mode.kind === "steer") await steer.mutateAsync({ id: conversationId, text });
      else await send.mutateAsync({ id: conversationId, text });
      return true;
    } catch (error) {
      const reason = errorReason(error);
      if (reason === "RUN_FINISHED") {
        // Too late to steer: the run is wrapping up. Keep the draft for a follow-up.
        toast.info(t("dashboard:conversation.composer.steerTooLate"));
      } else if (reason === "RUN_ACTIVE") {
        toast.info(t("dashboard:conversation.composer.alreadyRunning"));
      } else {
        toast.error(friendly(error, t("dashboard:conversation.composer.failed")));
      }
      return false;
    }
  };

  return (
    <Composer
      mode={mode}
      live={live}
      submitting={steer.isPending || send.isPending}
      stopping={stop.isPending}
      onSubmit={onSubmit}
      onStop={() => stop.mutate({ id: conversationId })}
    />
  );
}

function ConversationSkeleton() {
  return (
    <div className="mx-auto flex h-[100cqh] w-full max-w-4xl flex-col" aria-hidden="true">
      <div className="space-y-3 border-b px-4 py-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="flex-1 space-y-5 px-4 py-5">
        <Skeleton className="ms-auto h-14 w-2/3 rounded-2xl" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-28 w-4/5 rounded-lg" />
      </div>
      <div className="border-t px-4 py-3">
        <Skeleton className="h-[52px] w-full rounded-md" />
      </div>
    </div>
  );
}
