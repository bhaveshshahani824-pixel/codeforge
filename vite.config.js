import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2022", "chrome112", "safari16"],
    minify: "esbuild",
    sourcemap: false,
  },
});
