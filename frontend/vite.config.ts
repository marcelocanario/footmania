import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

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
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
