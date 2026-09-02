import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Footmania",
        short_name: "Footmania",
         description: "Football manager simulation game",
         lang: "en",
         dir: "ltr",
        theme_color: "#050e09",
        background_color: "#050e09",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png}"],
        // The SPA navigateFallback must never answer API navigations: the
        // Google OAuth callback (/api/auth/callback/google) is a top-level
        // navigation, and if the service worker serves index.html instead of
        // letting it reach the backend, no session is ever created and every
        // /api/account/me call fails with 401 after login.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          // Reference data that is safe to cache across users/sessions:
          // country list is global and rarely changes.
          {
            urlPattern: /^\/api\/mp\/countries/,
            handler: "NetworkFirst",
            options: { cacheName: "api-reference", networkTimeoutSeconds: 5, expiration: { maxEntries: 8, maxAgeSeconds: 3600 } },
          },
          // Auth, personalized and live endpoints must never be served stale
          // or cached by the PWA. Use NetworkOnly so the service worker always
          // re-validates against the origin.
          {
            urlPattern: /^\/api\//,
            handler: "NetworkOnly",
            options: { cacheName: "api-dynamic" },
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          icons: ["lucide-react"],
          i18n: ["i18next", "react-i18next"],
        },
      },
    },
  },
  server: {
    port: 3000,
    fs: { allow: [".", ".."] },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      "@server-i18n": fileURLToPath(new URL("../backend/src/i18n", import.meta.url)),
    },
  },
});
