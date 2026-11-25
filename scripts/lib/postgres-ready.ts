/**
 * Waits until Postgres answers a query, not just until its port accepts a
 * TCP connection. On a fresh volume Docker's port proxy accepts connections on
 * 127.0.0.1:5432 while the container is still in initdb (the entrypoint's
 * temporary server listens on the Unix socket only), so a port probe passes
 * and the first migration fails with a reset connection.
 */

import { createRequire } from "node:module";

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "error", listener: () => void): void;
  connection?: { stream?: { destroy(): void } };
}
interface PgModule {
  Client: new (config: {
    connectionString: string;
    connectionTimeoutMillis: number;
    query_timeout: number;
  }) => PgClient;
}

/**
 * SQLSTATEs that waiting cannot fix: wrong password, no such role/auth rule,
 * no such database. Startup states (57P03 "starting up", resets, refusals)
 * are retried.
 */
const PERMANENT_CODES = new Set(["28P01", "28000", "3D000"]);

/** An error that retrying will not fix. */
export class PermanentDatabaseError extends Error {}

/**
 * One `SELECT 1` against `url`. Rejects when Postgres can't serve it within
 * `timeoutMs`, covering connect, query and a stalled server; the socket is
 * destroyed on every outcome so nothing keeps the process alive.
 */
export async function queryOnce(url: string, timeoutMs = 3000): Promise<void> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new PermanentDatabaseError("DATABASE_URL is not a valid URL");
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new PermanentDatabaseError("DATABASE_URL is not a postgres:// URL");
  }
  const pg = createRequire(import.meta.url)("pg") as PgModule;
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  // A server that drops the socket mid-handshake emits "error" on the client;
  // without a listener that would crash the process instead of rejecting.
  client.on("error", () => {});
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs);
  });
  let answered = false;
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        await client.query("SELECT 1");
      })(),
      deadline,
    ]);
    answered = true;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && PERMANENT_CODES.has(code)) {
      throw new PermanentDatabaseError(`${(err as Error).message} (SQLSTATE ${code})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    // A clean goodbye when the server answered (no "connection reset" in its
    // log); end() waits on the server, so a stalled one gets the socket closed.
    if (answered) {
      await Promise.race([
        client.end().catch(() => {}),
        new Promise((r) => setTimeout(r, 1000).unref()),
      ]);
    }
    client.connection?.stream?.destroy();
  }
}

export interface WaitForPostgresOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Per-attempt limit; capped by the time left. */
  attemptTimeoutMs?: number;
  /** Test seam; defaults to a real `SELECT 1`. */
  probe?: (url: string, timeoutMs: number) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries `probe` until it succeeds or `timeoutMs` passes. Resolves with the
 * attempt count; rejects with the last error's message when time runs out, or
 * at once on a {@link PermanentDatabaseError}.
 */
export async function waitForPostgres(
  url: string,
  options: WaitForPostgresOptions,
): Promise<number> {
  const probe = options.probe ?? queryOnce;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = options.intervalMs ?? 1000;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 3000;
  const deadline = now() + options.timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    let lastError: string;
    try {
      await probe(url, Math.max(1, Math.min(attemptTimeoutMs, deadline - now())));
      return attempt;
    } catch (err) {
      if (err instanceof PermanentDatabaseError) throw err;
      lastError = err instanceof Error ? err.message || err.name : String(err);
    }
    const left = deadline - now();
    if (left <= 0) {
      throw new Error(
        `Postgres did not answer a query within ${Math.round(options.timeoutMs / 1000)}s (${lastError})`,
      );
    }
    await sleep(Math.min(intervalMs, left));
  }
}
