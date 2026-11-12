import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const testIoGuard = fileURLToPath(new URL("./scripts/test-io-guard.ts", import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    passWithNoTests: true,
    setupFiles: [testIoGuard],
    exclude: [...configDefaults.exclude, "**/dist/**", "**/dev-dist/**", "**/*.contract.test.ts"],
  },
});
