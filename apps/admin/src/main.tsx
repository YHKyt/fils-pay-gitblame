import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { AdminAuthProvider } from "./auth/AdminAuthContext.js";
import { router } from "./router.js";
// Inter, bundled offline via @fontsource (Vite emits the woff2 locally — no
// CDN, no network fetch at runtime). The weights the admin UI actually uses.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
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
