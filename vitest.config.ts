import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts", "mcp/**/*.ts"],
      exclude: ["src/cli.ts", "**/*.d.ts"],
    },
    testTimeout: 30000,
  },
});
