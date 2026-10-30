import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router.js";
// Inter, bundled offline via @fontsource (woff2 emitted into dist by Vite) —
// no CDN, so the hosted air-gapped box renders the brand type with no network.
// 400 body, 500/600 UI weights, 700 for headings and amounts.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./tokens.css";
import { applyStoredTheme } from "./theme.js";

// Reflect the saved light/dark choice before first paint (no flash). With no
// saved choice this is a no-op and the OS preference drives the theme.
applyStoredTheme();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("main.tsx: #root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
