import { CodeSnippet } from "@cockpit-context/ui/components/code-snippet";
import { cn } from "@cockpit-context/ui/lib/utils";
import {
  Archive,
  Braces,
  ChevronDown,
  CircleAlert,
  FileText,
  FolderSearch,
  Navigation,
  Search,
  Sparkles,
  Users,
  Wrench,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Markdown } from "@/components/markdown";
import { RunStatusPill } from "@/components/run-status-pill";
import {
  isActive,
  isKnownStopReason,
  type MessagePart,
  partText,
  type RunView,
  readableToolOutput,
  sameRuns,
  sameToolCallView,
  summarizeToolCall,
  type ToolCallView,
  type ToolOutcome,
  type TranscriptBlock,
  toolCallOf,
  toolResultsOf,
} from "@/lib/conversations";

/**
 * The conversation transcript (docs/product.md): questions
 * and follow-ups, steering turns ("You steered: …"), the agent's messages
 * as markdown with each tool call as a collapsible one-line row, helper
 * runs as nested panels under the `delegate_explore` call that started
 * them (streaming live), and a closing note for a run that did not finish.
 *
 * Every string here is untrusted (model-written, checkout content, or an
 * agent's question over MCP): plain text, or `Markdown` without raw HTML.
 */

type ToolResults = ReadonlyMap<string, { content: string | null; error: boolean }>;

/** Helper panels do not nest helpers of their own. */
const NO_HELPERS: ReadonlyMap<string, RunView[]> = new Map();

function PulseDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full bg-current motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

export function TranscriptBlocks({
  blocks,
  askedBy,
}: {
  blocks: TranscriptBlock[];
  /** The MCP connection that asked the first question; null for the web. */
  askedBy: string | null;
}) {
  return (
    <ol className="min-w-0 space-y-5">
      {blocks.map((block) => (
        <li key={block.key} className="min-w-0">
          <Block block={block} askedBy={askedBy} />
        </li>
      ))}
    </ol>
  );
}

function Block({ block, askedBy }: { block: TranscriptBlock; askedBy: string | null }) {
  const { t } = useTranslation(["dashboard"]);
  switch (block.kind) {
    case "question":
      return (
        <div className="flex min-w-0 flex-col items-end">
          <p className="mb-1 text-xs text-muted-foreground">
            {block.followUp
              ? t("dashboard:conversation.transcript.followUp")
              : askedBy
                ? t("dashboard:conversation.transcript.askedBy", { name: askedBy })
                : t("dashboard:conversation.transcript.youAsked")}
          </p>
          <p className="max-w-[min(85%,40rem)] rounded-2xl rounded-ee-sm bg-primary px-4 py-3 text-sm break-words whitespace-pre-wrap text-primary-foreground">
            {block.text}
          </p>
        </div>
      );
    case "steer":
      return (
        <div className="flex min-w-0 flex-col items-end">
          <div className="flex max-w-[min(85%,40rem)] min-w-0 items-start gap-2 rounded-2xl rounded-ee-sm border border-dashed border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm">
            <Navigation
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
            />
            <p className="min-w-0 break-words whitespace-pre-wrap">
              <span className="font-medium text-amber-800 dark:text-amber-200">
                {t("dashboard:conversation.transcript.steered")}
              </span>{" "}
              {block.text}
            </p>
          </div>
        </div>
      );
    case "assistant":
      return (
        <AssistantMessage
          parts={block.parts}
          results={block.results}
          helpers={block.helpers}
          streaming={block.streaming}
          final={block.final}
        />
      );
    case "answer":
      return <AnswerCard text={block.text} />;
    case "helpers":
      return (
        <div className="space-y-2">
          {block.runs.map((run) => (
            <HelperPanel key={run.id} run={run} />
          ))}
        </div>
      );
    case "working":
      return <WorkingLine run={block.run} />;
    case "ended":
      return <EndedNote run={block.run} />;
  }
}

function AnswerCard({ text }: { text: string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <section className="min-w-0 rounded-xl border bg-card p-4 shadow-xs">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles aria-hidden="true" className="size-3.5" />
        {t("dashboard:conversation.transcript.answer")}
      </p>
      <Markdown content={text} />
    </section>
  );
}

function AssistantMessage({
  parts,
  results,
  helpers,
  streaming,
  final,
}: {
  parts: readonly MessagePart[];
  results: ToolResults;
  helpers: ReadonlyMap<string, RunView[]>;
  streaming: boolean;
  final: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const text = final ? partText(parts) : "";
  if (final && text) return <AnswerCard text={text} />;
  return (
    <div className="min-w-0 space-y-2">
      <MessageParts parts={parts} results={results} helpers={helpers} />
      {streaming ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <PulseDot className="text-primary-text" />
          {t("dashboard:conversation.transcript.streaming")}
        </p>
      ) : null}
    </div>
  );
}

function MessageParts({
  parts,
  results,
  helpers,
}: {
  parts: readonly MessagePart[];
  results: ToolResults;
  helpers: ReadonlyMap<string, RunView[]>;
}) {
  return (
    <>
      {parts.map((part, index) => {
        // The index disambiguates repeated parts that carry no id of their own.
        const key = `${index}-${part.type}`;
        if (part.type === "text") {
          const content = partText([part]);
          return content ? <Markdown key={key} content={content} /> : null;
        }
        const call = toolCallOf(part, results);
        if (call) {
          return (
            <ToolCallRow key={`${key}-${call.id}`} call={call} helpers={helpers.get(call.id)} />
          );
        }
        // Results render inside their call's row; reasoning is not shown
        // (it is neither durable nor an answer).
        return null;
      })}
    </>
  );
}

const TOOL_ICONS: Record<string, typeof Search> = {
  grep: Search,
  glob: FolderSearch,
  read: FileText,
  delegate_explore: Users,
  retrieve_tool_result: Archive,
};

function toolIcon(name: string) {
  return TOOL_ICONS[name] ?? (name.startsWith("lsp_") ? Braces : Wrench);
}

function useOutcomeText() {
  const { t } = useTranslation(["dashboard"]);
  return (outcome: ToolOutcome): string => {
    if (outcome.kind === "error") return t("dashboard:conversation.tools.failed");
    const text = t(`dashboard:conversation.tools.${outcome.kind}`, { count: outcome.count });
    return outcome.truncated ? t("dashboard:conversation.tools.truncated", { text }) : text;
  };
}

function prettyArgs(call: ToolCallView): string {
  if (Object.keys(call.args).length === 0) return call.argsText;
  return JSON.stringify(call.args, null, 2);
}

/**
 * Memoized: every watch event (deltas every ~100 ms) rebuilds the
 * transcript, and a row's summary parses its whole output. A row re-renders
 * only when what it shows changed.
 */
const ToolCallRow = memo(
  ToolCallRowView,
  (a, b) => sameToolCallView(a.call, b.call) && sameRuns(a.helpers, b.helpers),
);

function ToolCallRowView({ call, helpers }: { call: ToolCallView; helpers?: RunView[] }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const [open, setOpen] = useState(false);
  const outcomeText = useOutcomeText();
  const summary = summarizeToolCall(call);
  const Icon = toolIcon(call.name);
  const label = [
    call.name,
    summary.subject,
    summary.scope ? t("dashboard:conversation.tools.in", { scope: summary.scope }) : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="min-w-0 rounded-lg border bg-muted/20">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-start text-xs transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono" title={label}>
          <span className="font-semibold">{call.name}</span>
          {summary.subject ? <span className="text-foreground"> {summary.subject}</span> : null}
          {summary.scope ? (
            <span className="text-muted-foreground">
              {" "}
              {t("dashboard:conversation.tools.in", { scope: summary.scope })}
            </span>
          ) : null}
        </span>
        {summary.outcome ? (
          <span
            className={cn(
              "shrink-0",
              summary.outcome.kind === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span aria-hidden="true">→ </span>
            {outcomeText(summary.outcome)}
          </span>
        ) : call.pending ? (
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            <PulseDot />
            <span className="sr-only sm:not-sr-only">
              {t("dashboard:conversation.tools.running")}
            </span>
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="min-w-0 space-y-2 border-t p-3">
          {call.argsText ? (
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("dashboard:conversation.tools.arguments")}
              </p>
              <CodeSnippet
                code={prettyArgs(call)}
                copyLabel={t("common:actions.copy")}
                preClassName="max-h-40 overflow-x-auto overflow-y-auto overscroll-contain whitespace-pre-wrap break-words"
              />
            </div>
          ) : null}
          {call.output !== null ? (
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("dashboard:conversation.tools.result")}
              </p>
              <CodeSnippet
                code={readableToolOutput(call.output)}
                copyLabel={t("common:actions.copy")}
                preClassName="max-h-72 overflow-x-auto overflow-y-auto overscroll-contain whitespace-pre-wrap break-words"
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("dashboard:conversation.tools.noResult")}
            </p>
          )}
        </div>
      ) : null}
      {helpers && helpers.length > 0 ? (
        <div className="min-w-0 space-y-2 border-t p-2">
          {helpers.map((run, index) => (
            <HelperPanel key={run.id} run={run} position={index} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const HelperPanel = memo(HelperPanelView);

function HelperPanelView({ run, position }: { run: RunView; position?: number }) {
  const { t } = useTranslation(["dashboard"]);
  const live = isActive(run.status);
  // A running helper opens so it can be watched; a finished one stays tidy.
  const [open, setOpen] = useState(live);
  const number = (run.helperIndex ?? position ?? 0) + 1;
  const results = useMemo(
    () => toolResultsOf(run.partial ? [...run.turns, run.partial] : run.turns),
    [run.turns, run.partial],
  );
  // One keyed list, by assistant ordinal like the main transcript: the
  // streaming message is the newest, so the saved turn that replaces it
  // keeps its key (and the reader's expanded rows).
  const messages: Array<{ parts: readonly MessagePart[] }> = run.turns.filter(
    (turn) => turn.role === "assistant",
  );
  if (run.partial) messages.push(run.partial);

  return (
    <section className="min-w-0 rounded-md border-s-2 border-primary/40 bg-background">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-start text-xs transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Users aria-hidden="true" className="size-4 shrink-0 text-primary-text" />
        <span className="shrink-0 font-medium">
          {t("dashboard:conversation.helpers.title", { number })}
        </span>
        {run.focus ? (
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
            {run.focus}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <RunStatusPill status={run.status} />
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="min-w-0 space-y-2 border-t px-3 py-3">
          {messages.map((message, index) => (
            <div key={`a${index}`} className="min-w-0 space-y-2">
              <MessageParts parts={message.parts} results={results} helpers={NO_HELPERS} />
            </div>
          ))}
          {live ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <PulseDot className="text-primary-text" />
              {t("dashboard:conversation.helpers.working")}
            </p>
          ) : run.turns.length === 0 && !run.partial ? (
            <p className="text-xs text-muted-foreground">
              {t("dashboard:conversation.helpers.empty")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function WorkingLine({ run }: { run: RunView }) {
  const { t } = useTranslation(["dashboard"]);
  const phase = run.phase ?? (run.status === "queued" ? "queued" : "running");
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
      <PulseDot className="text-primary-text" />
      {t(`dashboard:conversation.phase.${phase}`)}
    </p>
  );
}

function EndedNote({ run }: { run: RunView }) {
  const { t } = useTranslation(["dashboard"]);
  const reason = isKnownStopReason(run.stopReason)
    ? t(`dashboard:conversation.stopReasons.${run.stopReason}`)
    : null;
  const tone = run.status === "failed" ? "bad" : "muted";
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        tone === "bad" ? "border-destructive/30 bg-destructive/5" : "bg-muted/40",
      )}
    >
      <CircleAlert
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "bad" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{t(`dashboard:conversation.ended.${run.status}`)}</p>
        {reason ? <p className="text-muted-foreground">{reason}</p> : null}
      </div>
    </div>
  );
}
