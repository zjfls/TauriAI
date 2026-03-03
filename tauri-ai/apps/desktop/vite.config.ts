import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const configDir = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Tauri production uses a custom protocol origin; relative base is the most robust across schemes.
  base: "./",
  // Ensure Vite resolves `index.html`, `public/`, PostCSS/Tailwind config relative to this app.
  root: configDir,

  plugins: [react()],

  // Test configuration
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1425,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1426,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // Tauri production runs from a custom local origin (tauri.localhost). Disable Vite's modulepreload
    // helper to avoid circular chunk imports that can trigger TDZ ("Cannot access 'x' before initialization").
    modulePreload: false,
    // Keep desktop and mobile outputs separated for long-term maintainability.
    outDir: path.resolve(configDir, "../../dist/desktop"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;

          if (id.includes("/monaco-editor/") || id.includes("/@monaco-editor/")) {
            return "vendor-monaco";
          }
          if (
            id.includes("/xterm/") ||
            id.includes("/@xterm/") ||
            id.includes("/portable-pty/")
          ) {
            return "vendor-terminal";
          }
          if (id.includes("/pdfjs-dist/")) {
            return "vendor-pdf";
          }
          if (id.includes("/@tauri-apps/")) {
            return "vendor-tauri";
          }
          if (
            id.includes("/@dnd-kit/") ||
            id.includes("/lucide-react/") ||
            id.includes("/gpt-tokenizer/")
          ) {
            return "vendor-ui";
          }

          return "vendor-misc";
        },
      },
    },
  },
}));
