import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { AdminAuthProvider } from "./auth/AdminAuthContext.js";
import { router } from "./router.js";
// Fonts, all bundled offline via @fontsource (Vite emits the woff2 locally —
// no CDN, no network fetch at runtime), and only the weights the "Pearl of
// the Gulf" admin identity actually uses:
//   • Inter — body / UI text
//   • Fraunces — the display face for the wordmark and headings
//   • JetBrains Mono — amounts, ids and code
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./admin.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("main.tsx: #root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AdminAuthProvider>
      <RouterProvider router={router} />
    </AdminAuthProvider>
  </React.StrictMode>,
);
