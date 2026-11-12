import { Worker } from "node:worker_threads";

import type { GrepMatch, GrepResult } from "./fs-ops";

/** What the worker needs; every path is already confined and real (see `exploreGrepJs`). */
export type GrepWorkerParams = {
  /** The real explore root; match paths are reported relative to it. */
  rootReal: string;
  /** The real, confined search base: a directory to walk, or one file to search. */
  base: string;
  pattern: string;
  flags: string;
  maxMatches: number;
  maxFileBytes: number;
  maxMatchTextChars: number;
  skipDirNames: string[];
  /** Entries skipped whatever their type: `.git`, which is a file in a linked worktree. */
  skipEntryNames: string[];
  binaryExtensions: string[];
};

/**
 * The JavaScript grep, run in a worker thread.
 *
 * A model-supplied RegExp can backtrack catastrophically (`(a+)+$` over a long
 * line), and `RegExp#test` is synchronous: on the main thread it would freeze
 * the whole app (server, web and jobs share one process) and nothing — not the
 * tool's abort signal, not the run deadline — could stop it. In a worker the
 * main thread keeps serving, and `worker.terminate()` interrupts the regex.
 *
 * The source is plain CommonJS kept in a string (`eval: true`) rather than a
 * separate file so it survives the server's bundler unchanged and needs no
 * TypeScript loader. It walks in ripgrep's `--sort path` order — entries sorted
 * by name within each directory, depth-first — and never follows a symbolic
 * link (ripgrep's default without `--follow`; files are opened `O_NOFOLLOW`),
 * so both backends return the same matches in the same order. `base` may be a
 * file, which is then searched whatever its extension, as ripgrep searches an
 * explicitly named file. Matches are posted one at a time so a timeout keeps
 * what was already found.
 */
const GREP_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData: d } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");

const skipDirs = new Set(d.skipDirNames);
const skipEntries = new Set(d.skipEntryNames);
const binaryExts = new Set(d.binaryExtensions);
const regex = new RegExp(d.pattern, d.flags);
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
let count = 0;

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function relative(absolute) {
  const rel = path.relative(d.rootReal, absolute);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

function clip(line) {
  return line.length > d.maxMatchTextChars ? line.slice(0, d.maxMatchTextChars) + "…" : line;
}

function readText(absolute) {
  let fd;
  try {
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > d.maxFileBytes) return null;
    const text = fs.readFileSync(fd, "utf8");
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/** Search one file; false once the match cap is reached. */
function search(absolute) {
  const text = readText(absolute);
  if (text === null) return true;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!regex.test(line)) continue;
    parentPort.postMessage({
      type: "match",
      match: { path: relative(absolute), line: index + 1, text: clip(line) },
    });
    count++;
    if (count >= d.maxMatches) return false;
  }
  return true;
}

function walk(current) {
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true }).sort(byName);
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (skipEntries.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      if (!walk(absolute)) return false;
      continue;
    }
    if (!entry.isFile()) continue;
    if (binaryExts.has(path.extname(entry.name).toLowerCase())) continue;
    if (!search(absolute)) return false;
  }
  return true;
}

let baseStat;
try {
  baseStat = fs.lstatSync(d.base);
} catch {}
if (baseStat && baseStat.isFile()) search(d.base);
else if (baseStat && baseStat.isDirectory()) walk(d.base);
parentPort.postMessage({ type: "done", truncated: count >= d.maxMatches });
`;

type WorkerMessage = { type: "match"; match: GrepMatch } | { type: "done"; truncated: boolean };

/** Thrown when the walk hit its time budget before finding anything. */
export class GrepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `grep timed out after ${Math.round(timeoutMs / 1000)}s with no matches; the pattern may backtrack catastrophically — simplify it, or narrow path.`,
    );
    this.name = "GrepTimeoutError";
  }
}

/**
 * Run the JavaScript grep off the main thread with a hard time budget.
 *
 * On timeout or abort the worker is terminated (which interrupts a running
 * regex). Matches found so far are returned as `truncated`; a timeout with none
 * is a `GrepTimeoutError` (the model should change the pattern), an abort with
 * none is an empty truncated result (the loop is abandoning the call anyway).
 */
export function runGrepWorker(
  params: GrepWorkerParams,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<GrepResult> {
  if (options.signal?.aborted) return Promise.resolve({ matches: [], truncated: true });
  return new Promise((resolve, reject) => {
    const matches: GrepMatch[] = [];
    let settled = false;

    const worker = new Worker(GREP_WORKER_SOURCE, {
      eval: true,
      workerData: params,
      // Files are capped at maxFileBytes; this only bounds a pathological heap.
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });

    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      outcome();
    };
    const stopEarly = (onEmpty: () => void) =>
      settle(() => (matches.length > 0 ? resolve({ matches, truncated: true }) : onEmpty()));

    const onAbort = () => stopEarly(() => resolve({ matches, truncated: true }));
    const timer = setTimeout(
      () => stopEarly(() => reject(new GrepTimeoutError(options.timeoutMs))),
      options.timeoutMs,
    );
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "match") {
        matches.push(message.match);
        return;
      }
      settle(() => resolve({ matches, truncated: message.truncated }));
    });
    worker.on("error", (error) =>
      settle(() =>
        reject(new Error(`grep failed: ${error instanceof Error ? error.message : String(error)}`)),
      ),
    );
    worker.on("exit", () =>
      settle(() => reject(new Error("grep failed: the search worker exited early"))),
    );
  });
}
