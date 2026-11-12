import {
  type AgentTool,
  UNTRUSTED_CONTENT_SYSTEM_RULES,
  wrapUntrustedContent,
} from "@cockpit-context/agent-runtime";

import { formatRepoMapForPrompt, type RepoMap } from "./repo-map";

/**
 * Base system prompt for the investigation agent (master, helpers, summary).
 *
 * Answer from the checkout's actual source with `file:line` citations. The
 * honesty clauses stop the model from inventing a tool result it never received.
 */
export const EXPLORE_SYSTEM_PROMPT = `You are Cockpit Context's investigation agent. Developers and their AI coding agents ask you how to use a dependency, and you answer from that dependency's real source code, checked out at the exact version they use.

You have read-only tools over that checkout: \`glob\`, \`grep\`, and \`read\`, plus any other tools listed in your tool definitions. Your working set is the checkout only — you cannot see outside it. You have NO shell and cannot write files.

When asked how something works, what an API looks like, or how to use the package:
1. Use \`glob\` / \`grep\` to find the relevant API (public exports, examples/, types, docs).
2. \`read\` the most promising file(s) to confirm the real signature and usage.
3. Answer from what you read — not from training memory when the source is available.

Output format for investigation answers:
- Lead with the answer in one sentence (the concrete call/pattern).
- Follow with \`file:line\` citations into the checkout.
- If the source does not show it, say so explicitly and name what you searched.
- Keep investigation answers under ~30 lines unless the question asks for more.

Never state or imply that you called a tool you did not call, and never present a tool's output as more certain than it is: report what it returned, including when it returned nothing. Do not invent paths you have not seen in tool output.`;

export const EXAMPLES_FIRST_PROMPT = `Workflow priority for usage questions:
1. Check README and paths under examplePaths / docs from the repo map (or glob \`examples/**\`, \`docs/**\`).
2. Only then search package source for the public API.
3. Stop as soon as you can cite a real example or export — do not explore beyond the brief.`;

export const MASTER_DELEGATE_PROMPT = `You are the master investigator for this query. Explore with glob/grep/read yourself first.

Use \`delegate_explore\` ONLY when parallel investigation of *different* subtrees would clearly help — e.g. a large monorepo question that spans docs + multiple packages, or after you discover the answer is split across distant areas. Pass 2–4 focused helper briefs (different paths/concerns). Do NOT delegate a question you can finish with a few local tool calls.

Helper agents are read-only and cannot delegate further. You synthesize their reports into the final answer and may verify with your own tools.`;

/** Appended to the prompt of the no-tool synthesis turn that follows budget exhaustion. */
export const FORCE_FINAL_SYSTEM_NOTE = `You must now produce the best final answer possible from the investigation transcript. You have no tools in this turn — do not claim or attempt tool calls. If evidence is incomplete, say what you found and what is still unknown. Cite file:line when possible.`;

/** The user message that opens the synthesis turn. */
export const FORCE_FINAL_USER_PROMPT =
  "The investigation budget ended. Write the final answer now from what you already learned.";

/** Longest overview (model-written or edited) injected into a prompt. */
const MAX_OVERVIEW_PROMPT_CHARS = 8_000;

/** What the run is investigating; every field comes from the owner's package row. */
export type ExplorePackageInfo = {
  /** Ecosystem-qualified identifier, e.g. `npm:@tanstack/react-query`. */
  identifier: string;
  /** The version or git ref the question targets, as requested. */
  versionOrRef?: string;
  /** The commit the checkout is at. */
  commit?: string;
  /** Monorepo subdirectory the package lives in, relative to the checkout root. */
  subdirectory?: string;
};

export type ExplorePromptInput = {
  /**
   * The tools whose output can appear in this conversation. Drives the
   * untrusted-content rules and the master-delegate section.
   */
  tools: readonly AgentTool[];
  package?: ExplorePackageInfo;
  /** The owner's notes about this package (trusted: the owner wrote them). */
  userNotes?: string;
  /**
   * The checkout's overview: the run owner's own edited version when they
   * have one, else the model-written summary.
   */
  overview?: string;
  /** Who wrote `overview`; labels its section header. Default `model`. */
  overviewSource?: OverviewSource;
  repoMap?: RepoMap;
  examplesFirst?: boolean;
  /** Extra trailing instruction (the force-final synthesis note). */
  trailer?: string;
};

/** `model`: the shared generated summary. `owner`: the run owner's own edit. */
export type OverviewSource = "model" | "owner";

const OVERVIEW_HEADERS: Record<OverviewSource, string> = {
  model: "## Repository overview (model-written, verify with tools)",
  owner: "## Repository overview (edited by the package's owner, verify with tools)",
};

export function formatPackageSection(info: ExplorePackageInfo): string {
  const lines = ["## Package under investigation", `- Package: ${info.identifier}`];
  lines.push(`- Version/ref: ${info.versionOrRef?.trim() || "latest default branch"}`);
  if (info.commit) lines.push(`- Resolved commit: ${info.commit}`);
  if (info.subdirectory?.trim()) {
    lines.push(
      `- Subdirectory focus: \`${info.subdirectory.trim()}\` — the package lives there; start there. The rest of the checkout is visible for shared code.`,
    );
  }
  return lines.join("\n");
}

/**
 * Assemble the system prompt in this order:
 *
 * 1. base explore prompt;
 * 2. untrusted-content rules (iff an untrusted tool is registered, or fenced
 *    context is injected below);
 * 3. "Package under investigation";
 * 4. user notes;
 * 5. overview: the owner's edited one, else the model-written one (if any);
 * 6. repo map;
 * 7. examples-first;
 * 8. master-delegate (iff `delegate_explore` is registered).
 *
 * The overview and the repo map are fenced as untrusted: the overview was
 * written by a model reading the dependency (an edited one often still
 * quotes it), and the map lists file and directory names the dependency's
 * authors chose.
 */
export function buildExploreSystemPrompt(input: ExplorePromptInput): string {
  const overview = input.overview?.trim();
  const sections = [EXPLORE_SYSTEM_PROMPT];

  const fencesContext = Boolean(overview) || input.repoMap !== undefined;
  if (fencesContext || input.tools.some((tool) => tool.untrusted === true)) {
    sections.push(UNTRUSTED_CONTENT_SYSTEM_RULES);
  }
  if (input.package) {
    sections.push(formatPackageSection(input.package));
  }
  const notes = input.userNotes?.trim();
  if (notes) {
    sections.push(`## Notes from the package's owner\n${notes}`);
  }
  if (overview) {
    const clipped =
      overview.length > MAX_OVERVIEW_PROMPT_CHARS
        ? `${overview.slice(0, MAX_OVERVIEW_PROMPT_CHARS)}\n…[truncated]`
        : overview;
    sections.push(
      `${OVERVIEW_HEADERS[input.overviewSource ?? "model"]}\n${wrapUntrustedContent(clipped, { sourceUrl: "checkout:overview" })}`,
    );
  }
  if (input.repoMap) {
    sections.push(
      `## Repo map (authoritative orientation; still verify with tools)\n${wrapUntrustedContent(
        `\`\`\`json\n${formatRepoMapForPrompt(input.repoMap)}\n\`\`\``,
        { sourceUrl: "checkout:repo-map" },
      )}`,
    );
  }
  if (input.examplesFirst) {
    sections.push(EXAMPLES_FIRST_PROMPT);
  }
  if (input.tools.some((tool) => tool.name === DELEGATE_EXPLORE_TOOL_NAME)) {
    sections.push(MASTER_DELEGATE_PROMPT);
  }
  if (input.trailer) {
    sections.push(input.trailer);
  }
  return sections.join("\n\n");
}

export const DELEGATE_EXPLORE_TOOL_NAME = "delegate_explore";
