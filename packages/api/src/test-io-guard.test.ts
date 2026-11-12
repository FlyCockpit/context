import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testIoGuardKey = Symbol.for("cockpit-context.test-io-guard");

describe("test I/O guard", () => {
  it("loads the non-restorable TCP guard before test imports", () => {
    const state = Reflect.get(globalThis, testIoGuardKey) as
      | { active?: unknown; connectionAttempts?: unknown }
      | undefined;

    expect(state?.active).toBe(true);
    expect(state?.connectionAttempts).toBe(0);
    expect(Reflect.get(net.Socket.prototype.connect, testIoGuardKey)).toBe(true);
  });

  it("fails the suite when code catches a blocked TCP attempt", async () => {
    const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const repoRoot = path.resolve(apiRoot, "../..");
    const vitestEntrypoint = path.join(repoRoot, "node_modules/vitest/vitest.mjs");
    const fixture = path.join(apiRoot, "src/test-io-guard-caught.fixture.ts");
    const config = path.join(repoRoot, "scripts/vitest-test-io-guard-fixture.config.ts");
    // Asynchronous, so this worker's event loop (and vitest's own timeout)
    // keep running while the nested vitest starts; a cold vitest start under a
    // loaded uncached `turbo run test` can take well over 10 s.
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      output: string;
    }>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [vitestEntrypoint, "run", fixture, "--config", config],
        { cwd: apiRoot, encoding: "utf8", timeout: 90_000, killSignal: "SIGKILL" },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") {
            reject(error);
            return;
          }
          resolve({ code: child.exitCode, signal: child.signalCode, output: `${stdout}${stderr}` });
        },
      );
    });

    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Test I/O guard blocked 1 TCP connection attempt(s)");
  }, 120_000);
});
