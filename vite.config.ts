import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const base = process.env.FAULTLINE_BASE ?? "/";

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: null,
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Faultline",
        short_name: "Faultline",
        description: "An interactive SRE and DevOps field lab.",
        theme_color: "#0A0E13",
        background_color: "#0A0E13",
        display: "standalone",
        start_url: base,
        scope: base,
        icons: [{ src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2,json}"],
        navigateFallback: `${base}index.html`,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { allowedHosts: [".ts.net"] },
  preview: { host: true, allowedHosts: [".ts.net", "100.96.116.16"] },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    css: false,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 400,
  },
});
