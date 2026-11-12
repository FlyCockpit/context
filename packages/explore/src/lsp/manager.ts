import { LspClient, LspError } from "./client";
import { type DetectedLanguages, detectLspLanguages } from "./detect";
import {
  createLspSandbox,
  type LspLaunch,
  type LspSandbox,
  type LspSandboxMode,
  type LspSandboxStatus,
} from "./sandbox";
import { LANGUAGE_SERVER_SPECS, type LanguageServerSpec, type LspLanguage } from "./specs";

/** COCKPIT_CONTEXT_LSP_MAX_SERVERS default. */
export const DEFAULT_LSP_MAX_SERVERS = 4;
/** COCKPIT_CONTEXT_LSP_IDLE_SECONDS default, in ms. */
export const DEFAULT_LSP_IDLE_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Heap cap per server: Node's --max-old-space-size, Go's GOMEMLIMIT. */
const DEFAULT_MEMORY_MB = 1_024;
/** Start failures or crashes of one server within the window that disable it. */
const DEFAULT_MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 10 * 60_000;
/** Language detections remembered at once; the least recently used is dropped past it. */
const MAX_CACHED_DETECTIONS = 256;

/** One server: a checkout, a language and the root-relative workspace dir. */
export type LspServerKey = {
  checkoutId: string;
  language: LspLanguage;
  /** Root-relative workspace directory (`"."` = the checkout root). */
  workspaceDir: string;
};

export type LspManagerOptions = {
  /** Servers running at once (COCKPIT_CONTEXT_LSP_MAX_SERVERS); LRU eviction past it. `0` disables LSP. */
  maxServers?: number;
  /** Idle time before a server is stopped (COCKPIT_CONTEXT_LSP_IDLE_SECONDS × 1000). */
  idleMs?: number;
  startTimeoutMs?: number;
  /** Per-request budget the tools use. */
  requestTimeoutMs?: number;
  memoryMb?: number;
  /** Override or replace server specs (tests use a fake server). */
  specs?: Partial<Record<LspLanguage, LanguageServerSpec>>;
  maxFailures?: number;
  /**
   * COCKPIT_CONTEXT_LSP_SANDBOX (default `required`): every server runs under the Landlock
   * helper, and without a working helper (or a kernel without Landlock) the
   * manager is disabled (no LSP tools). `off` runs servers directly. Tests
   * pass a prepared `LspSandbox`.
   */
  sandbox?: LspSandboxMode | LspSandbox;
};

/** Where one server runs: both absolute real host paths. */
export type LspServerRoots = {
  /** The checkout: the one directory of the data dir the sandbox lets the server read. */
  checkoutRoot: string;
  /** The server's workspace root: the checkout or a package subdirectory inside it. */
  workspaceRoot: string;
};

/** What the admin runtime-config screen shows. */
export type LspStatus = {
  /** LSP tools are offered to the agent. */
  enabled: boolean;
  maxServers: number;
  sandbox: LspSandboxStatus;
};

type Entry = {
  id: string;
  key: LspServerKey;
  roots: LspServerRoots;
  client?: LspClient;
  starting?: Promise<LspClient>;
  inFlight: number;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
  /** Set when the manager itself stops the server (idle, LRU, prune). */
  retired: boolean;
};

export type RunningLspServer = LspServerKey & { pid?: number; inFlight: number };

const keyId = (key: LspServerKey) => `${key.checkoutId}\0${key.language}\0${key.workspaceDir}`;

/**
 * Process-wide pool of language servers keyed by (checkout, language,
 * workspace dir).
 *
 * - Lazy: a server starts on the first tool call that needs it.
 * - Idle stop after `idleMs` with no call in flight.
 * - At most `maxServers` at once; starting another evicts the least recently
 *   used (an idle one first).
 * - `stopCheckout` stops every server of a checkout: call it before a
 *   checkout's worktree is removed (prune, delete).
 * - Servers run inside the sandbox (`sandbox.ts`, Landlock): they can read
 *   only their own files, /usr and the checkout (read-only), write only a
 *   private per-launch directory, open no TCP connection (Landlock ABI 4+),
 *   and get a minimal env (no secrets, PATH at an empty directory, so no
 *   `npm`, no `python`). With `sandbox: "required"` and no working helper the
 *   manager is disabled; it never falls back to an unsandboxed server.
 * - A server that fails to start or crashes `maxFailures` times within ten
 *   minutes is refused until `stopCheckout` (the tools then fall back to
 *   grep/read).
 * - `detectLanguages` remembers each checkout's language detection (checkouts
 *   are immutable) until `stopCheckout`, so a run start does not re-walk it.
 */
export class LspManager {
  readonly maxServers: number;
  readonly idleMs: number;
  readonly startTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly memoryMb: number;
  readonly specs: Readonly<Record<LspLanguage, LanguageServerSpec>>;
  private readonly maxFailures: number;
  private readonly entries = new Map<string, Entry>();
  private readonly failures = new Map<string, number[]>();
  private readonly detections = new Map<string, ReadonlyMap<LspLanguage, string>>();
  private readonly sandbox: LspSandbox;
  private disposed = false;

  constructor(options: LspManagerOptions = {}) {
    this.maxServers = Math.max(0, Math.floor(options.maxServers ?? DEFAULT_LSP_MAX_SERVERS));
    this.idleMs = Math.max(1, options.idleMs ?? DEFAULT_LSP_IDLE_MS);
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.memoryMb = options.memoryMb ?? DEFAULT_MEMORY_MB;
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.specs = { ...LANGUAGE_SERVER_SPECS, ...options.specs };
    const sandbox = options.sandbox ?? "required";
    this.sandbox = typeof sandbox === "string" ? createLspSandbox({ mode: sandbox }) : sandbox;
  }

  /**
   * False when `maxServers` is 0, the required sandbox is unavailable or its
   * probe has not passed yet (all: the LSP tools are not registered, fail
   * closed) or after `dispose`. Never blocks: the first check starts the
   * asynchronous Landlock probe (`ready()` waits for it).
   */
  get enabled(): boolean {
    if (this.maxServers <= 0 || this.disposed) return false;
    const { mode } = this.sandbox.status();
    return mode === "landlock" || mode === "off";
  }

  status(): LspStatus {
    return { enabled: this.enabled, maxServers: this.maxServers, sandbox: this.sandbox.status() };
  }

  /**
   * Starts the sandbox probe if needed and resolves with the status once it
   * settles. Boot does not await it (`void lsp.ready()`); scripts and checks do.
   */
  async ready(): Promise<LspStatus> {
    await this.sandbox.ready();
    return this.status();
  }

  /**
   * Run `fn` against the server for `key`, starting it if needed.
   * `roots.workspaceRoot` is the absolute real path of `key.workspaceDir`.
   */
  async use<T>(
    key: LspServerKey,
    roots: LspServerRoots,
    fn: (client: LspClient) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) throw new LspError("LSP tools are disabled", "start");
    const id = keyId(key);
    if (this.recentFailures(id) >= this.maxFailures) {
      throw new LspError("the language server failed repeatedly for this checkout", "start");
    }
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id, key, roots, inFlight: 0, lastUsed: Date.now(), retired: false };
      this.entries.set(id, entry);
    }
    entry.inFlight += 1;
    entry.lastUsed = Date.now();
    this.clearIdle(entry);
    try {
      const client = await this.ensureStarted(entry);
      return await fn(client);
    } finally {
      entry.inFlight -= 1;
      entry.lastUsed = Date.now();
      if (this.entries.get(id) === entry) this.scheduleIdle(entry);
    }
  }

  /**
   * `detectLspLanguages(root, { start })` with this manager's specs, cached per
   * (checkout, root, start). A walk that throws (a missing or escaping `start`)
   * is not cached.
   */
  detectLanguages(
    checkoutId: string,
    root: string,
    start?: string,
  ): ReadonlyMap<LspLanguage, string> {
    const id = `${checkoutId}\0${root}\0${start ?? ""}`;
    const cached = this.detections.get(id);
    if (cached) {
      // Refresh recency.
      this.detections.delete(id);
      this.detections.set(id, cached);
      return cached;
    }
    const detected: DetectedLanguages = detectLspLanguages(root, { start, specs: this.specs });
    this.detections.set(id, detected);
    while (this.detections.size > MAX_CACHED_DETECTIONS) {
      const oldest = this.detections.keys().next().value;
      if (oldest === undefined) break;
      this.detections.delete(oldest);
    }
    return detected;
  }

  /**
   * Stop every server of `checkoutId` and forget its failures and language
   * detections (prune / delete hook).
   */
  async stopCheckout(checkoutId: string): Promise<void> {
    const stops: Promise<void>[] = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.key.checkoutId === checkoutId) stops.push(this.retire(entry));
    }
    for (const id of [...this.failures.keys()]) {
      if (id.startsWith(`${checkoutId}\0`)) this.failures.delete(id);
    }
    for (const id of [...this.detections.keys()]) {
      if (id.startsWith(`${checkoutId}\0`)) this.detections.delete(id);
    }
    await Promise.allSettled(stops);
  }

  /** Stop everything and release the sandbox's private directories. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.detections.clear();
    await Promise.allSettled([...this.entries.values()].map((entry) => this.retire(entry)));
    this.sandbox.dispose();
  }

  running(): RunningLspServer[] {
    return [...this.entries.values()]
      .filter((entry) => entry.client?.alive || entry.starting)
      .map((entry) => ({ ...entry.key, pid: entry.client?.pid, inFlight: entry.inFlight }));
  }

  private async ensureStarted(entry: Entry): Promise<LspClient> {
    if (entry.client?.alive) return entry.client;
    if (entry.starting) return entry.starting;

    // Make room synchronously (before any await) so concurrent starts of
    // different keys cannot overshoot the cap.
    this.evictFor(entry);
    const starting = this.startClient(entry);
    entry.starting = starting;
    try {
      const client = await starting;
      if (entry.retired || this.entries.get(entry.id) !== entry) {
        // Evicted or pruned while starting.
        void client.stop();
        throw new LspError("the language server was stopped", "crashed");
      }
      entry.client = client;
      client.onExit(() => {
        if (entry.client !== client) return;
        entry.client = undefined;
        if (!entry.retired) {
          this.recordFailure(entry.id);
          console.warn(
            `[lsp] ${entry.key.language} server for checkout ${entry.key.checkoutId} exited unexpectedly`,
          );
        }
        if (this.entries.get(entry.id) === entry && entry.inFlight === 0) {
          this.clearIdle(entry);
          this.entries.delete(entry.id);
        }
      });
      return client;
    } catch (error) {
      if (!entry.retired) this.recordFailure(entry.id);
      throw error;
    } finally {
      entry.starting = undefined;
    }
  }

  /** Spawn the server for `entry` through the sandbox; every failure is a `start` LspError. */
  private async startClient(entry: Entry): Promise<LspClient> {
    const spec = this.specs[entry.key.language];
    const { checkoutRoot, workspaceRoot } = entry.roots;
    let launch: LspLaunch;
    try {
      launch = this.sandbox.launch({
        server: spec.command({ memoryMb: this.memoryMb }),
        checkoutRoot,
        workspaceRoot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LspError(`could not start the language server (${message})`, "start");
    }
    return LspClient.start({
      spec,
      workspaceRoot,
      launch,
      startTimeoutMs: this.startTimeoutMs,
    });
  }

  private evictFor(entry: Entry): void {
    const live = () =>
      [...this.entries.values()].filter(
        (other) => other !== entry && (other.client?.alive || other.starting),
      );
    let others = live();
    while (others.length >= this.maxServers && others.length > 0) {
      // Least recently used, preferring servers with nothing in flight.
      others.sort((a, b) => {
        const busy = Number(a.inFlight > 0) - Number(b.inFlight > 0);
        return busy !== 0 ? busy : a.lastUsed - b.lastUsed;
      });
      const victim = others[0];
      if (!victim) break;
      void this.retire(victim);
      others = live();
    }
  }

  private retire(entry: Entry): Promise<void> {
    entry.retired = true;
    this.clearIdle(entry);
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    const client = entry.client;
    entry.client = undefined;
    const starting = entry.starting;
    if (client) return client.stop();
    if (starting) {
      return starting.then(
        (started) => started.stop(),
        () => {},
      );
    }
    return Promise.resolve();
  }

  private scheduleIdle(entry: Entry): void {
    this.clearIdle(entry);
    if (entry.inFlight > 0) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.inFlight === 0 && this.entries.get(entry.id) === entry) {
        void this.retire(entry);
      }
    }, this.idleMs);
    entry.idleTimer.unref();
  }

  private clearIdle(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private recordFailure(id: string): void {
    const now = Date.now();
    const recent = (this.failures.get(id) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
    recent.push(now);
    this.failures.set(id, recent);
  }

  private recentFailures(id: string): number {
    const now = Date.now();
    return (this.failures.get(id) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS).length;
  }
}
