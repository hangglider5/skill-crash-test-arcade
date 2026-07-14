import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  resolve: {
    alias: { "@protocol": path.resolve("src/protocol/schema.ts") }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4317", changeOrigin: false }
    },
    fs: { allow: [path.resolve(".")] }
  },
  build: { outDir: "../../dist/web", emptyOutDir: true }
});
