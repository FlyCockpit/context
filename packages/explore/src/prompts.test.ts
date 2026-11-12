import { defineTool, UNTRUSTED_CONTENT_SYSTEM_RULES } from "@cockpit-context/agent-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildExploreSystemPrompt,
  EXAMPLES_FIRST_PROMPT,
  EXPLORE_SYSTEM_PROMPT,
  FORCE_FINAL_SYSTEM_NOTE,
  formatPackageSection,
  MASTER_DELEGATE_PROMPT,
} from "./prompts";
import type { RepoMap } from "./repo-map";

const untrustedTool = defineTool({
  name: "read",
  description: "read",
  inputSchema: z.object({}),
  untrusted: true,
  execute: () => "",
});
const trustedTool = defineTool({
  name: "noop",
  description: "noop",
  inputSchema: z.object({}),
  execute: () => "",
});
const delegateTool = defineTool({
  name: "delegate_explore",
  description: "delegate",
  inputSchema: z.object({}),
  untrusted: true,
  execute: () => "",
});

const repoMap: RepoMap = {
  generatedAt: "t",
  rootName: "sample-pkg",
  languages: ["typescript"],
  manifests: [],
  entrypoints: [],
  examplePaths: ["examples"],
  docPaths: [],
  topLevel: ["examples", "src"],
  notablePackages: [],
  hints: [],
};

describe("buildExploreSystemPrompt", () => {
  it("assembles every section in the documented order", () => {
    const prompt = buildExploreSystemPrompt({
      tools: [untrustedTool, delegateTool],
      package: {
        identifier: "npm:@scope/sample",
        versionOrRef: "1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
        subdirectory: "packages/sample",
      },
      userNotes: "OWNER-NOTES-MARK",
      overview: "OVERVIEW-MARK",
      repoMap,
      examplesFirst: true,
    });

    const order = [
      EXPLORE_SYSTEM_PROMPT,
      UNTRUSTED_CONTENT_SYSTEM_RULES,
      "## Package under investigation",
      "OWNER-NOTES-MARK",
      "## Repository overview (model-written, verify with tools)",
      "## Repo map",
      EXAMPLES_FIRST_PROMPT,
      MASTER_DELEGATE_PROMPT,
    ].map((needle) => prompt.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt.startsWith(EXPLORE_SYSTEM_PROMPT)).toBe(true);
  });

  it("fences the model-written overview and the repo map as untrusted", () => {
    const prompt = buildExploreSystemPrompt({ tools: [], overview: "OVERVIEW-MARK", repoMap });
    const overviewAt = prompt.indexOf("OVERVIEW-MARK");
    const mapAt = prompt.indexOf('"rootName": "sample-pkg"');
    const fenceBefore = (at: number) =>
      prompt.lastIndexOf("<<<UNTRUSTED_WEB_CONTENT_START>>>", at) >
      prompt.lastIndexOf("<<<UNTRUSTED_WEB_CONTENT_END>>>", at);
    expect(fenceBefore(overviewAt)).toBe(true);
    expect(fenceBefore(mapAt)).toBe(true);
    // Fenced context brings the rules even without an untrusted tool.
    expect(prompt).toContain(UNTRUSTED_CONTENT_SYSTEM_RULES);
  });

  it("leaves the owner's notes outside the fence", () => {
    const prompt = buildExploreSystemPrompt({ tools: [untrustedTool], userNotes: "NOTES" });
    const at = prompt.indexOf("NOTES");
    // The rules text names both markers; no fence is open at the notes.
    expect(prompt.lastIndexOf("<<<UNTRUSTED_WEB_CONTENT_START>>>", at)).toBeLessThan(
      prompt.lastIndexOf("<<<UNTRUSTED_WEB_CONTENT_END>>>", at),
    );
  });

  it("derives the untrusted rules and the delegate section from the tool list", () => {
    const bare = buildExploreSystemPrompt({ tools: [trustedTool] });
    expect(bare).not.toContain(UNTRUSTED_CONTENT_SYSTEM_RULES);
    expect(bare).not.toContain(MASTER_DELEGATE_PROMPT);
    expect(bare).not.toContain(EXAMPLES_FIRST_PROMPT);

    const withTools = buildExploreSystemPrompt({ tools: [untrustedTool] });
    expect(withTools).toContain(UNTRUSTED_CONTENT_SYSTEM_RULES);
    expect(withTools).not.toContain(MASTER_DELEGATE_PROMPT);
  });

  it("appends the trailer last", () => {
    const prompt = buildExploreSystemPrompt({
      tools: [untrustedTool],
      repoMap,
      trailer: FORCE_FINAL_SYSTEM_NOTE,
    });
    expect(prompt.endsWith(FORCE_FINAL_SYSTEM_NOTE)).toBe(true);
  });

  it("labels an owner-edited overview as edited, still fenced", () => {
    const prompt = buildExploreSystemPrompt({
      tools: [],
      overview: "EDITED-MARK",
      overviewSource: "owner",
    });
    expect(prompt).toContain(
      "## Repository overview (edited by the package's owner, verify with tools)",
    );
    expect(prompt).not.toContain("model-written");
    const at = prompt.indexOf("EDITED-MARK");
    expect(prompt.lastIndexOf("<<<UNTRUSTED_WEB_CONTENT_START>>>", at)).toBeGreaterThan(
      prompt.lastIndexOf("<<<UNTRUSTED_WEB_CONTENT_END>>>", at),
    );
  });

  it("clips a runaway overview", () => {
    const prompt = buildExploreSystemPrompt({ tools: [], overview: "o".repeat(20_000) });
    expect(prompt).toContain("…[truncated]");
    expect(prompt.length).toBeLessThan(EXPLORE_SYSTEM_PROMPT.length + 10_000);
  });
});

describe("formatPackageSection", () => {
  it("names the identifier, version, commit and subdirectory", () => {
    const section = formatPackageSection({
      identifier: "npm:left-pad",
      versionOrRef: "v1.3.0",
      commit: "abc123",
      subdirectory: "packages/left-pad",
    });
    expect(section).toContain("- Package: npm:left-pad");
    expect(section).toContain("- Version/ref: v1.3.0");
    expect(section).toContain("- Resolved commit: abc123");
    expect(section).toContain("`packages/left-pad`");
  });

  it("says latest default branch when no version was given", () => {
    const section = formatPackageSection({ identifier: "npm:left-pad" });
    expect(section).toContain("- Version/ref: latest default branch");
    expect(section).not.toContain("Resolved commit");
    expect(section).not.toContain("Subdirectory");
  });
});
