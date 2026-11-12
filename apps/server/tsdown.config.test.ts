import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { expect, it } from "vitest";
import config from "./tsdown.config";

it("keeps the MCP plugin and OAuth request-state reader in one production module graph", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "cockpit-context-oauth-bundle-"));
  try {
    // Build without evaluating the entry: database, env and network boundaries
    // never execute. This catches the production-only split that unit mocks miss.
    const result = await build({
      ...config,
      config: false,
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      outDir,
      logLevel: "silent",
    });
    try {
      const chunks = result.bundles.flatMap((bundle) => bundle.chunks);
      const imports = chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.imports : []));
      const modules = chunks.flatMap((chunk) =>
        chunk.type === "chunk" ? Object.keys(chunk.modules) : [],
      );
      // MCP imports oauthProvider, which owns a module-local request-state key.
      // An external MCP beside an inlined provider gets a different key and
      // cannot share the validated authorize/consent query with our grant hooks.
      expect(imports).not.toContain("@better-auth/mcp");
      expect(imports).not.toContain("@better-auth/oauth-provider");
      expect(modules.filter((id) => /@better-auth\/mcp\/dist\/index\.mjs$/.test(id))).toHaveLength(
        1,
      );
      expect(
        modules.filter((id) =>
          /@better-auth\/oauth-provider\/dist\/authorize-[^/]+\.mjs$/.test(id),
        ),
      ).toHaveLength(1);
    } finally {
      await Promise.all(result.bundles.map((bundle) => bundle[Symbol.asyncDispose]()));
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}, 30_000);
