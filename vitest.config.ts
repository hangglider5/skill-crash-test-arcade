import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@protocol": path.resolve("src/protocol/schema.ts") }
  },
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "test/protocol/**/*.test.ts",
            "test/arena/**/*.test.ts",
            "test/core/**/*.test.ts",
            "test/codex/**/*.test.ts",
            "test/integration/**/*.test.ts"
          ]
        }
      },
      {
        test: {
          name: "web",
          environment: "jsdom",
          include: ["test/web/**/*.test.tsx"],
          setupFiles: ["test/setup.ts"]
        }
      }
    ]
  }
});
