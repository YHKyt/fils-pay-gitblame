import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router.js";
// Brand type, all bundled offline via @fontsource (woff2 emitted into dist by
// Vite) — no CDN, so the hosted air-gapped box renders the identity with no
// network. Three families carry the "Pearl of the Gulf" voice:
//   • Fraunces — a high-contrast display serif for the wordmark, page titles
//     and hero amounts (the characterful, unmistakable part of the brand);
//   • Inter — body, UI, tables and forms (even, legible at small sizes);
//   • JetBrains Mono — amounts, ids and codes (tabular digits that line up).
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "@fontsource/fraunces/900.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
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
