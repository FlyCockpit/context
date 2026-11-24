import enDashboard from "@cockpit-context/locales/src/en-US/dashboard.json";
import esDashboard from "@cockpit-context/locales/src/es-MX/dashboard.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import { TranscriptBlocks } from "@/components/conversations/transcript";
import {
  applyWatchEvent,
  buildTranscript,
  type ConversationDetail,
  type ConversationViewState,
  type MessagePart,
  type WatchEvent,
} from "@/lib/conversations";

const NOW = new Date("2026-11-24T00:45:00Z");
type DetailRun = ConversationDetail["runs"][number];
type Status = DetailRun["status"];

const question: MessagePart = { type: "text", content: "How does routing work?" };
const message: MessagePart = { type: "text", content: "I'll look at the router." };
const glob: MessagePart = {
  type: "tool-call",
  id: "c1",
  name: "glob",
  arguments: JSON.stringify({ pattern: "lib/router/**" }),
  state: "complete",
};

/** A conversation whose run saved the question and a message whose glob never got a result. */
function conversation(status: Status): ConversationDetail {
  const live = status === "running";
  return {
    id: "c-1",
    createdAt: NOW,
    title: "How does routing work?",
    packageId: "pkg-1",
    packageIdentifier: "npm:express",
    requestedVersion: "5.1.0",
    requestedRef: null,
    commitSha: "a".repeat(40),
    resolvedFrom: "tag:v5.1.0",
    checkoutAvailable: true,
    origin: "web",
    mcpConnectionLabel: null,
    lastActivityAt: NOW,
    ongoing: live,
    totalCostUsdMicros: 0,
    totalUnpricedCalls: 0,
    latestRun: null,
    truncated: false,
    runs: [
      {
        id: "run-1",
        createdAt: NOW,
        parentRunId: null,
        kind: "main",
        status,
        trigger: "web_message",
        model: "fake/model",
        focus: null,
        stopReason: live ? null : "aborted",
        iterations: 1,
        startedAt: NOW,
        finishedAt: live ? null : NOW,
        answer: null,
        failure: null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          costUsdMicros: 0,
          unpricedCalls: 0,
        },
        turns: [
          { seq: 0, role: "user", parts: [question], steering: false, createdAt: NOW },
          { seq: 1, role: "assistant", parts: [message, glob], steering: false, createdAt: NOW },
        ],
      },
    ],
  };
}

function fold(events: WatchEvent[]): ConversationViewState {
  const state = events.reduce<ConversationViewState | null>(applyWatchEvent, null);
  if (!state) throw new Error("no state");
  return state;
}

async function render(state: ConversationViewState, lng = "en-US"): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: "en-US",
    ns: ["dashboard"],
    defaultNS: "dashboard",
    resources: { "en-US": { dashboard: enDashboard }, "es-MX": { dashboard: esDashboard } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TranscriptBlocks blocks={buildTranscript(state)} askedBy={null} />
    </I18nextProvider>,
  );
}

const snapshot = (status: Status): WatchEvent => ({
  type: "snapshot",
  conversation: conversation(status),
  live: { runs: [] },
});
const PULSE = "animate-pulse";

describe("TranscriptBlocks tool calls", () => {
  it("shows a call without a result as running while its run is live", async () => {
    const html = await render(fold([snapshot("running")]));
    expect(html).toContain(">Running<");
    expect(html).toContain(PULSE);
  });

  it("never shows a call without a result as running once the run has ended", async () => {
    for (const status of ["stopped", "failed", "interrupted"] as const) {
      const html = await render(fold([snapshot(status)]));
      expect(html).toContain("glob");
      expect(html).not.toContain(">Running<");
      expect(html).not.toContain(PULSE);
    }
  });

  it("renders a run stopped live like the same run reloaded, in en-US and es-MX", async () => {
    const stopLive: WatchEvent[] = [
      snapshot("running"),
      {
        type: "delta",
        runId: "run-1",
        message: { id: "m2", role: "assistant", parts: [message, { ...glob, id: "c2" }] },
      },
      {
        type: "run.finished",
        runId: "run-1",
        status: "stopped",
        stopReason: "aborted",
        answer: null,
      },
    ];
    for (const lng of ["en-US", "es-MX"]) {
      const live = await render(fold(stopLive), lng);
      expect(live).toBe(await render(fold([snapshot("stopped")]), lng));
      expect(live).not.toContain(PULSE);
      expect(live).toContain(lng === "en-US" ? "Stopped." : "Detenida.");
    }
  });
});
