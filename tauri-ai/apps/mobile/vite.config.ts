import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => ({
  root: configDir,
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1423,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: path.resolve(configDir, "../../dist/mobile"),
    emptyOutDir: true,
  },
}));

