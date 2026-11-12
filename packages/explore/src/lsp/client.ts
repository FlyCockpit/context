import { type ChildProcess, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  ApplyWorkspaceEditRequest,
  CancellationTokenSource,
  type ConfigurationParams,
  ConfigurationRequest,
  createProtocolConnection,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  type InitializeParams,
  InitializeRequest,
  type ProtocolConnection,
  type ProtocolRequestType,
  PublishDiagnosticsNotification,
  type PublishDiagnosticsParams,
  type RequestParam,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
  WorkspaceFoldersRequest,
} from "vscode-languageserver-protocol/node";

import type { LspLaunch } from "./sandbox";
import type { LanguageServerSpec } from "./specs";

/** Why an LSP call failed; every kind becomes a tool error, never a run failure. */
export type LspFailureKind = "start" | "crashed" | "timeout" | "aborted" | "request";

export class LspError extends Error {
  constructor(
    message: string,
    readonly kind: LspFailureKind,
  ) {
    super(message);
    this.name = "LspError";
  }
}

export type LspClientOptions = {
  spec: LanguageServerSpec;
  /** Absolute, real host path of the server's workspace root. */
  workspaceRoot: string;
  /**
   * The process to spawn: the Landlock helper around the server, or the
   * server itself (sandbox.ts). Paths are the same on both sides: no mount
   * namespace, so the server sees the checkout at its real path.
   */
  launch: LspLaunch;
  startTimeoutMs: number;
  /** Documents kept open at once; the oldest is closed past this. */
  maxOpenDocuments?: number;
};

const DEFAULT_MAX_OPEN_DOCUMENTS = 64;
/** How long `stop()` waits for a clean `shutdown`/`exit` before SIGKILL. */
const STOP_GRACE_MS = 1_000;
/** Tail of the server's stderr kept for the crash log line. */
const STDERR_TAIL_CHARS = 2_000;

const ACKNOWLEDGED_SERVER_REQUESTS = [
  "client/registerCapability",
  "client/unregisterCapability",
  "window/workDoneProgress/create",
  "window/showMessageRequest",
  "window/showDocument",
  "workspace/codeLens/refresh",
  "workspace/semanticTokens/refresh",
  "workspace/inlayHint/refresh",
  "workspace/inlineValue/refresh",
  "workspace/diagnostic/refresh",
] as const;

const SILENT_LOGGER = {
  error: () => {},
  warn: () => {},
  info: () => {},
  log: () => {},
};

/** Client capabilities: only what the five tools use, plus configuration pull. */
const CLIENT_CAPABILITIES: InitializeParams["capabilities"] = {
  general: { positionEncodings: ["utf-16"] },
  workspace: {
    configuration: true,
    workspaceFolders: true,
    symbol: { dynamicRegistration: false },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
    definition: { dynamicRegistration: false, linkSupport: false },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
  },
};

/**
 * One language-server process over stdio (JSON-RPC via
 * `vscode-languageserver-protocol`). Requests are bounded by a timeout and the
 * caller's abort signal; an exit at any point rejects everything in flight.
 */
export class LspClient {
  private readonly openDocuments = new Map<string, true>();
  private readonly exitListeners = new Set<() => void>();
  private exited = false;
  private stopping = false;
  private stderrTail = "";

  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: ProtocolConnection,
    private readonly options: LspClientOptions,
    private readonly diagnosticsListeners: Set<(params: PublishDiagnosticsParams) => void>,
  ) {
    child.once("exit", () => {
      this.exited = true;
      options.launch.cleanup();
      this.connection.dispose();
      for (const listener of this.exitListeners) listener();
      this.exitListeners.clear();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
  }

  /** Spawn the server and complete `initialize` / `initialized`. */
  static async start(options: LspClientOptions): Promise<LspClient> {
    const { command, args, env, cwd } = options.launch;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // A server that dies mid-write must not surface as an unhandled EPIPE, and
    // a late spawn/kill error must not crash the process.
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});

    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) =>
        reject(new LspError(`could not start the language server (${error.message})`, "start")),
      );
    });
    try {
      await spawned;
    } catch (error) {
      child.kill("SIGKILL");
      options.launch.cleanup();
      throw error;
    }

    const connection = createProtocolConnection(
      new StreamMessageReader(child.stdout as NodeJS.ReadableStream),
      new StreamMessageWriter(child.stdin as NodeJS.WritableStream),
      SILENT_LOGGER,
    );
    connection.onRequest(ConfigurationRequest.type, (params: ConfigurationParams) =>
      params.items.map((item) => options.spec.configuration(item.section)),
    );
    // Requests the servers send that need only an acknowledgement. Anything
    // else gets JSON-RPC MethodNotFound, which servers tolerate.
    for (const method of ACKNOWLEDGED_SERVER_REQUESTS) {
      connection.onRequest(method, () => null);
    }
    const rootUri = pathToFileURL(options.workspaceRoot).href;
    connection.onRequest(WorkspaceFoldersRequest.type, () => [{ uri: rootUri, name: "checkout" }]);
    connection.onRequest(ApplyWorkspaceEditRequest.type, () => ({ applied: false }));
    const diagnosticsListeners = new Set<(params: PublishDiagnosticsParams) => void>();
    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      for (const listener of diagnosticsListeners) listener(params);
    });
    connection.onError(() => {});
    connection.listen();

    const client = new LspClient(child, connection, options, diagnosticsListeners);
    try {
      await client.race(
        connection.sendRequest(InitializeRequest.type, {
          processId: process.pid,
          clientInfo: { name: "cockpit-context" },
          rootUri,
          rootPath: options.workspaceRoot,
          workspaceFolders: [{ uri: rootUri, name: "checkout" }],
          capabilities: CLIENT_CAPABILITIES,
          initializationOptions: options.spec.initializationOptions ?? null,
        }),
        { timeoutMs: options.startTimeoutMs, phase: "start" },
      );
      connection.sendNotification(InitializedNotification.type, {});
    } catch (error) {
      await client.stop();
      if (error instanceof LspError) {
        throw new LspError(`the language server did not initialize (${error.message})`, "start");
      }
      throw new LspError("the language server did not initialize", "start");
    }
    return client;
  }

  get alive(): boolean {
    return !this.exited && !this.stopping;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** The last lines the server wrote to stderr (operator logs only, never the model). */
  get stderr(): string {
    return this.stderrTail;
  }

  onExit(listener: () => void): () => void {
    if (this.exited) {
      listener();
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Diagnostics the server pushes (`textDocument/publishDiagnostics`), with
   * server URIs. No tool forwards them to the model; the sandbox check
   * (`sandbox-check.ts`) watches them for leaks. Returns the unsubscribe.
   */
  onDiagnostics(listener: (params: PublishDiagnosticsParams) => void): () => void {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }

  /**
   * `didOpen` a document (absolute path) once and return its URI; checkouts
   * are immutable, so no `didChange`. A `text` function is called only when
   * the document is not open yet, so a repeat open reads nothing.
   */
  openDocument(absolutePath: string, languageId: string, text: string | (() => string)): string {
    const uri = pathToFileURL(absolutePath).href;
    if (this.openDocuments.has(uri)) {
      // Refresh recency.
      this.openDocuments.delete(uri);
      this.openDocuments.set(uri, true);
      return uri;
    }
    const content = typeof text === "function" ? text() : text;
    this.ensureAlive();
    this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId, version: 1, text: content },
    });
    this.openDocuments.set(uri, true);
    const max = this.options.maxOpenDocuments ?? DEFAULT_MAX_OPEN_DOCUMENTS;
    while (this.openDocuments.size > max) {
      const oldest = this.openDocuments.keys().next().value;
      if (oldest === undefined) break;
      this.openDocuments.delete(oldest);
      this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: oldest },
      });
    }
    return uri;
  }

  async request<P, R, PR, E, RO>(
    type: ProtocolRequestType<P, R, PR, E, RO>,
    params: NoInfer<RequestParam<P>>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<R> {
    this.ensureAlive();
    const cancel = new CancellationTokenSource();
    try {
      return await this.race(this.connection.sendRequest(type, params, cancel.token), {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        phase: "request",
        onGiveUp: () => cancel.cancel(),
      });
    } finally {
      cancel.dispose();
    }
  }

  /** `shutdown` + `exit`, then SIGKILL after a grace period. Idempotent. */
  async stop(): Promise<void> {
    if (this.exited) return;
    const wasStopping = this.stopping;
    this.stopping = true;
    const exitedPromise = new Promise<void>((resolve) => this.onExit(resolve));
    if (!wasStopping) {
      try {
        await this.race(this.connection.sendRequest(ShutdownRequest.type), {
          timeoutMs: STOP_GRACE_MS,
          phase: "request",
        });
        this.connection.sendNotification(ExitNotification.type);
      } catch {
        // Unresponsive or already gone: fall through to the kill.
      }
    }
    const timer = setTimeout(() => this.child.kill("SIGKILL"), STOP_GRACE_MS);
    timer.unref();
    try {
      await exitedPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  private ensureAlive(): void {
    if (this.exited) throw new LspError("the language server exited", "crashed");
    if (this.stopping) throw new LspError("the language server is stopping", "crashed");
  }

  /**
   * Settle `work` against the server exiting, a timeout and an abort, all
   * mapped to `LspError`. `onGiveUp` runs when the caller stops waiting.
   */
  private race<T>(
    work: Promise<T>,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      phase: "start" | "request";
      onGiveUp?: () => void;
    },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanups: Array<() => void> = [];
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        for (const cleanup of cleanups) cleanup();
        outcome();
      };
      const giveUp = (error: LspError) =>
        finish(() => {
          options.onGiveUp?.();
          reject(error);
        });

      const timer = setTimeout(
        () => giveUp(new LspError(`timed out after ${options.timeoutMs} ms`, "timeout")),
        options.timeoutMs,
      );
      cleanups.push(() => clearTimeout(timer));

      cleanups.push(
        this.onExit(() =>
          finish(() => reject(new LspError("the language server exited unexpectedly", "crashed"))),
        ),
      );

      const signal = options.signal;
      if (signal) {
        const onAbort = () => giveUp(new LspError("the call was aborted", "aborted"));
        if (signal.aborted) onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", onAbort));
      }

      work.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) =>
          finish(() => {
            if (this.exited) {
              reject(new LspError("the language server exited unexpectedly", "crashed"));
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            reject(new LspError(message, "request"));
          }),
      );
    });
  }
}
