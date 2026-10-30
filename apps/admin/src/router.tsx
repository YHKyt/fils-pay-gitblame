import { createBrowserRouter, Navigate } from "react-router-dom";
import { AdminLayout } from "./components/AdminLayout.js";
import { RequireAdminAuth } from "./components/RequireAdminAuth.js";
import { AdjustmentImportPage } from "./pages/adjustments/AdjustmentImportPage.js";
import { CreditsPage } from "./pages/credits/CreditsPage.js";
import { LoginPage } from "./pages/login/LoginPage.js";
import { MerchantListPage } from "./pages/merchants/MerchantListPage.js";
import { MerchantDetailPage } from "./pages/merchants/MerchantDetailPage.js";
import { SettlementPage } from "./pages/settlement/SettlementPage.js";
import { WebhookReplayPage } from "./pages/webhooks/WebhookReplayPage.js";

// MK: /v2 routes live behind VITE_ADMIN_V2 — see the admin v2 doc
export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    // Everything below the login screen shares one shell and one guard. The
    // guard is navigation only — the API re-checks the admin session on
    // every request these pages make.
    element: (
      <RequireAdminAuth>
        <AdminLayout />
      </RequireAdminAuth>
    ),
    children: [
      { path: "/", element: <Navigate to="/merchants" replace /> },
      { path: "/merchants", element: <MerchantListPage /> },
      { path: "/merchants/:id", element: <MerchantDetailPage /> },
      { path: "/credits", element: <CreditsPage /> },
      { path: "/settlement", element: <SettlementPage /> },
      { path: "/adjustment-imports", element: <AdjustmentImportPage /> },
      { path: "/webhooks", element: <WebhookReplayPage /> },
      { path: "/webhooks/:merchantId", element: <WebhookReplayPage /> },
    ],
  },
], {
  // "/" in dev; "/admin" when built for the hosted stack (ops/Dockerfile.web
  // builds with --base=/admin/ so the console shares the dashboard's origin).
  basename: import.meta.env.BASE_URL.replace(/\/$/, "") || "/",
});
