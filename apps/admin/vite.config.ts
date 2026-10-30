import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Same-origin /v1 in dev and preview, like apps/web: apps/api has no CORS
// handling. When hosted, nginx does this (ops/nginx.web.conf).
const apiProxy = {
  "/v1": { target: process.env.API_PROXY_TARGET ?? "http://localhost:3000", changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    // 5174 clashes with storybook on my machine — am
    port: 5174,
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
});
