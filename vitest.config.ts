import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The gate.
 *
 * Fast and dependency-free on purpose: `npm test` must be runnable before every
 * merge without Docker, without credentials and without the network, or it will
 * stop being run. Anything needing the local database or a broker lives behind
 * its own script.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Every date-sensitive rule in this repo is written against Asia/Seoul or
    // America/New_York explicitly, so the suite must not depend on where it is
    // run. Pinning UTC means a machine in Seoul and one in CI agree.
    env: { TZ: "UTC" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
