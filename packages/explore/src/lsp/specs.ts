import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * The languages supported by the investigation language servers. The registry below is the
 * extension point: Go (`gopls`) and Rust (`rust-analyzer`, build scripts and
 * proc macros off) are later entries once their toolchains are in the image.
 */
export type LspLanguage = "typescript" | "python";

/** How to launch one server process. */
export type LanguageServerCommand = {
  command: string;
  args: string[];
  /** Added to the minimal env the sandbox builds (never the host's env). */
  env?: Record<string, string>;
  /**
   * Files and directories the server needs to run, bound read-only into the
   * sandbox at the same path (sandbox.ts). The command itself is always bound;
   * /usr is always there. Nothing else of the host is visible to the server.
   */
  readOnlyPaths?: string[];
};

export type LanguageServerSpec = {
  language: LspLanguage;
  /** Shown to the model in tool descriptions, e.g. "TypeScript/JavaScript". */
  label: string;
  /** File extension (lower case, with the dot) → LSP `languageId`. */
  languageIds: Readonly<Record<string, string>>;
  /**
   * Files that make a package subdirectory its own project: when the package
   * under investigation lives in a subdirectory holding one of these, the
   * server's workspace root is that subdirectory instead of the checkout.
   */
  projectMarkers: readonly string[];
  /** The process to spawn. `memoryMb` caps the server's heap. */
  command: (options: { memoryMb: number }) => LanguageServerCommand;
  initializationOptions?: unknown;
  /** The answer to one `workspace/configuration` item. */
  configuration: (section: string | undefined) => unknown;
};

const localRequire = createRequire(import.meta.url);

/**
 * TypeScript 7's native language server (`tsc --lsp --stdio`).
 *
 * The catalog's TypeScript is 7, which ships no `tsserver.js`, so
 * `typescript-language-server` cannot drive it; TypeScript 7 serves LSP itself.
 * It also has no plugin system (TypeScript 6's tsserver loads tsconfig
 * `plugins` by package name), and it has no workspace-TypeScript lookup a
 * checkout could hijack with a committed `node_modules/typescript`. Spawn the
 * platform binary directly so no Node launcher sits between us and it; fall
 * back to the package's launcher, which `execve`s the same binary.
 */
export function resolveTypeScriptServerCommand(): {
  command: string;
  args: string[];
  readOnlyPaths: string[];
} {
  const packageJson = localRequire.resolve("typescript/package.json");
  const packageDir = path.dirname(packageJson);
  try {
    const platformPackage = createRequire(packageJson).resolve(
      `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
    );
    const binary = path.join(
      path.dirname(platformPackage),
      "lib",
      process.platform === "win32" ? "tsc.exe" : "tsc",
    );
    if (fs.statSync(binary).isFile()) {
      // The platform package is self-contained: the binary and its lib.*.d.ts.
      return {
        command: binary,
        args: ["--lsp", "--stdio"],
        readOnlyPaths: [path.dirname(platformPackage)],
      };
    }
  } catch {
    // No platform package for this host; use the launcher below.
  }
  return {
    command: process.execPath,
    args: [path.join(packageDir, "bin", "tsc"), "--lsp", "--stdio"],
    readOnlyPaths: [packageDir],
  };
}

/** `pyright-langserver` from the pinned `pyright` package. */
export function resolvePyrightServerScript(): string {
  return localRequire.resolve("pyright/langserver.index.js");
}

/** The `pyright` package directory: a self-contained bundle (dist/ and its typeshed). */
function pyrightPackageDir(): string {
  return path.dirname(localRequire.resolve("pyright/package.json"));
}

/**
 * Settings answered to the TypeScript server's `workspace/configuration`
 * pull. Automatic type acquisition is ON by default in TypeScript 7 and runs
 * `npm install` into a global typings cache; this is the switch it honors
 * (verified: `initializationOptions` alone does not stop it). The minimal env
 * also has no `npm` on PATH, as a second fence.
 */
const TYPESCRIPT_SETTINGS = {
  tsserver: { automaticTypeAcquisition: { enabled: false } },
  disableAutomaticTypeAcquisition: true,
  workspaceSymbols: { excludeLibrarySymbols: true },
  referencesCodeLens: { enabled: false },
  implementationsCodeLens: { enabled: false },
  validate: { enabled: false },
};

const typescriptSpec: LanguageServerSpec = {
  language: "typescript",
  label: "TypeScript/JavaScript",
  languageIds: {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascriptreact",
  },
  projectMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
  command: ({ memoryMb }) => ({
    ...resolveTypeScriptServerCommand(),
    // A Go binary: GOMEMLIMIT is its (soft) heap cap, the analogue of Node's
    // --max-old-space-size. GOMAXPROCS keeps one server off every core.
    env: { GOMEMLIMIT: `${memoryMb}MiB`, GOMAXPROCS: "2" },
  }),
  initializationOptions: { disableAutomaticTypeAcquisition: true },
  configuration: () => TYPESCRIPT_SETTINGS,
};

/**
 * Pyright. Its interpreter discovery runs `python3`/`python` from PATH to read
 * `sys.path`; the minimal env has no PATH entries, so it never executes an
 * interpreter and resolves imports from the checkout plus its bundled
 * typeshed. A checkout's `venvPath`/`venv` config is only read as directories.
 */
const PYTHON_ANALYSIS = {
  autoSearchPaths: true,
  useLibraryCodeForTypes: true,
  diagnosticMode: "openFilesOnly",
  typeCheckingMode: "off",
  autoImportCompletions: false,
};

const pythonSpec: LanguageServerSpec = {
  language: "python",
  label: "Python",
  languageIds: { ".py": "python", ".pyi": "python" },
  projectMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg"],
  command: ({ memoryMb }) => ({
    command: process.execPath,
    args: [`--max-old-space-size=${memoryMb}`, resolvePyrightServerScript(), "--stdio"],
    readOnlyPaths: [pyrightPackageDir()],
  }),
  configuration: (section) => {
    if (section === "python.analysis") return PYTHON_ANALYSIS;
    if (section === "python") return { analysis: PYTHON_ANALYSIS };
    if (section === "pyright") return { disableOrganizeImports: true };
    return null;
  },
};

export const LANGUAGE_SERVER_SPECS: Readonly<Record<LspLanguage, LanguageServerSpec>> = {
  typescript: typescriptSpec,
  python: pythonSpec,
};

/** The language whose server handles `filePath`, by extension. */
export function languageForPath(
  filePath: string,
  specs: Readonly<Record<LspLanguage, LanguageServerSpec>> = LANGUAGE_SERVER_SPECS,
): LspLanguage | undefined {
  const ext = path.extname(filePath).toLowerCase();
  for (const spec of Object.values(specs)) {
    if (ext in spec.languageIds) return spec.language;
  }
  return undefined;
}
