/**
 * Local fake OpenRouter for development and UI testing. Scripted, free, and
 * never a real model.
 *
 *   pnpm run fake-openrouter                      # http://localhost:4010/api/v1
 *   pnpm run fake-openrouter -- --port 4011 --step-delay-ms 2500 --delegate always
 *
 * Then start the app with
 *
 *   COCKPIT_CONTEXT_OPENROUTER_BASE_URL=http://localhost:4010/api/v1 OPENROUTER_API_KEY=fake COCKPIT_CONTEXT_MODEL=fake/model
 *
 * Flags:
 *   --port <n>            listen port (default 4010; 0 picks a free one)
 *   --host <addr>         listen address (default 127.0.0.1). `0.0.0.0` only
 *                         inside a throwaway container for an image smoke test
 *   --step-delay-ms <n>   pause before each response (default 1500)
 *   --chunk-delay-ms <n>  pause between streamed chunks (default 30)
 *   --delegate <mode>     auto | always | never — when the master calls
 *                         delegate_explore (auto: the question mentions helpers,
 *                         delegation, parallel work or a deep dive)
 *   --quiet               no per-request log lines
 *
 * It listens on 127.0.0.1 unless --host says otherwise.
 */

import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

import { createFakeOpenRouterServer, type DelegateMode } from "./lib/fake-openrouter.ts";

const { values } = parseArgs({
  // `pnpm run <script> -- --flag` forwards the `--` itself; drop it.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  options: {
    port: { type: "string", default: "4010" },
    host: { type: "string", default: "127.0.0.1" },
    "step-delay-ms": { type: "string", default: "1500" },
    "chunk-delay-ms": { type: "string", default: "30" },
    delegate: { type: "string", default: "auto" },
    quiet: { type: "boolean", default: false },
  },
});

const nonNegativeInt = (raw: string, flag: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`[fake-openrouter] --${flag} must be a non-negative integer, got "${raw}"`);
    process.exit(1);
  }
  return value;
};

const delegate = values.delegate;
if (delegate !== "auto" && delegate !== "always" && delegate !== "never") {
  console.error(`[fake-openrouter] --delegate must be auto, always or never, got "${delegate}"`);
  process.exit(1);
}

const server = createFakeOpenRouterServer({
  stepDelayMs: nonNegativeInt(values["step-delay-ms"], "step-delay-ms"),
  chunkDelayMs: nonNegativeInt(values["chunk-delay-ms"], "chunk-delay-ms"),
  delegate: delegate satisfies DelegateMode,
  log: values.quiet ? undefined : (line) => console.log(line),
});

server.listen(nonNegativeInt(values.port, "port"), values.host, () => {
  const { port } = server.address() as AddressInfo;
  const base = `http://localhost:${port}/api/v1`;
  console.log(`[fake-openrouter] listening on ${base}`);
  console.log(
    `[fake-openrouter] start the app with: COCKPIT_CONTEXT_OPENROUTER_BASE_URL=${base} OPENROUTER_API_KEY=fake COCKPIT_CONTEXT_MODEL=fake/model`,
  );
});

const shutdown = () => {
  server.close();
  server.closeAllConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
