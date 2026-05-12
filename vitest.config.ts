import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["workspace-tests/**", "node_modules/**", "dist/**"],
  },
});
