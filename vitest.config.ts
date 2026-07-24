import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Blocks every outbound request: no test may reach the real provider.
    setupFiles: ["./tests/setup.ts"],
  },
});
