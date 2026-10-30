import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard talks to apps/api on its own origin: the API has no CORS
// handling at all, so a cross-origin call (5173 -> 3000) dies on the
// preflight (`OPTIONS /v1/...` -> 404, no Access-Control-* headers) and the
// browser reports "Failed to fetch". Proxying /v1 keeps every request
// same-origin, so the fp_sid cookie is first-party and no CORS is needed.
// In the hosted stack nginx does the same job (ops/nginx.web.conf).
const apiProxy = {
  "/v1": {
    target: process.env.API_PROXY_TARGET ?? "http://localhost:3000",
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
});
