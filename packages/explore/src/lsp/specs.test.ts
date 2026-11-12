import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  LANGUAGE_SERVER_SPECS,
  languageForPath,
  resolvePyrightServerScript,
  resolveTypeScriptServerCommand,
} from "./specs";

describe("language server specs", () => {
  it("TypeScript runs TypeScript 7's native server, heap-capped, with type acquisition off", () => {
    const command = LANGUAGE_SERVER_SPECS.typescript.command({ memoryMb: 512 });
    expect(command.args.slice(-2)).toEqual(["--lsp", "--stdio"]);
    expect(fs.statSync(command.command).isFile()).toBe(true);
    expect(command.env).toEqual({ GOMEMLIMIT: "512MiB", GOMAXPROCS: "2" });
    for (const section of ["js/ts", "typescript", "javascript", "editor", undefined]) {
      expect(LANGUAGE_SERVER_SPECS.typescript.configuration(section)).toMatchObject({
        tsserver: { automaticTypeAcquisition: { enabled: false } },
        disableAutomaticTypeAcquisition: true,
      });
    }
    expect(LANGUAGE_SERVER_SPECS.typescript.initializationOptions).toEqual({
      disableAutomaticTypeAcquisition: true,
    });
  });

  it("resolves the TypeScript binary or its launcher", () => {
    const { command, args } = resolveTypeScriptServerCommand();
    expect(fs.existsSync(command)).toBe(true);
    if (command === process.execPath) expect(args[0]).toMatch(/typescript[/\\]bin[/\\]tsc$/);
  });

  it("Python runs pyright-langserver under Node with --max-old-space-size", () => {
    const command = LANGUAGE_SERVER_SPECS.python.command({ memoryMb: 768 });
    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([
      "--max-old-space-size=768",
      resolvePyrightServerScript(),
      "--stdio",
    ]);
    expect(fs.existsSync(resolvePyrightServerScript())).toBe(true);
    expect(LANGUAGE_SERVER_SPECS.python.configuration("python.analysis")).toMatchObject({
      diagnosticMode: "openFilesOnly",
    });
    expect(LANGUAGE_SERVER_SPECS.python.configuration("unrelated")).toBeNull();
  });

  it("maps file extensions to languages", () => {
    expect(languageForPath("src/a.tsx")).toBe("typescript");
    expect(languageForPath("lib/a.CJS")).toBe("typescript");
    expect(languageForPath("pkg/mod.pyi")).toBe("python");
    expect(languageForPath("src/lib.rs")).toBeUndefined();
    expect(languageForPath("Makefile")).toBeUndefined();
  });
});
