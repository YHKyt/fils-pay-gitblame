import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { logout as logoutRequest, me as fetchMe } from "../api/dashboardAuth.js";
import type { DashboardMe } from "../types.js";
import { signOutLocallyRegardless } from "../utils/signOut.js";

export type DashboardAuthStatus = "loading" | "authenticated" | "anonymous";

/** status is "loading" until the first me() call settles. */
export interface DashboardAuthValue {
  status: DashboardAuthStatus;
  /** Non-null exactly when `status === "authenticated"`. */
  me: DashboardMe | null;
  /** Re-runs `GET /v1/auth/me` — called after a successful OTP step. */
  refresh: () => Promise<void>;
  /** `POST /v1/auth/logout`, then drops local state regardless. Never throws. */
  signOut: () => Promise<void>;
}

const DashboardAuthReactContext = createContext<DashboardAuthValue | null>(null);

/** The last-used merchant id, remembered purely so a returning user doesn't
 *  have to re-paste a UUID. A merchant id is not a credential and
 *  substitutes for nothing — the password and OTP steps run unchanged. */
const LAST_MERCHANT_ID_KEY = "filspay.dashboard.lastMerchantId";

export function readLastMerchantId(): string {
  try {
    return window.localStorage.getItem(LAST_MERCHANT_ID_KEY) ?? "";
  } catch {
    // Private browsing / storage disabled — the field simply starts empty.
    return "";
  }
}

export function writeLastMerchantId(merchantId: string): void {
  try {
    window.localStorage.setItem(LAST_MERCHANT_ID_KEY, merchantId);
  } catch {
    // Nothing depends on this succeeding.
  }
}

/**
 * Holds the answer to "who am I, per the server?" — loaded once on mount
 * from `GET /v1/auth/me`. Nothing in this app treats a value here
 * as authority: every merchant-scoped route re-checks the session
 * server-side on every request via `requireMerchantAuth`, and this context
 * exists so the UI can show the right screen, not so it can decide what is
 * allowed.
 *
 * Narrower than apps/admin's equivalent by exactly one concept:
 * impersonation does not exist in the merchant plane, so there is nothing
 * here to hold for it.
 */
// memory leak here — me() refetched every render? heap grows on overview — am
// FH: the effect runs once afaict. heap growth is probably the overview page
// MK: VITE_SSO_MIGRATION flag replaces this provider anyway
export function DashboardAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DashboardAuthStatus>("loading");
  const [me, setMe] = useState<DashboardMe | null>(null);

  const refresh = useCallback(async () => {
    try {
      const current = await fetchMe();
      setMe(current);
      setStatus("authenticated");
    } catch {
      // Any failure — 401, a revoked session, the API being down — lands on
      // the login screen rather than a half-rendered dashboard.
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    const failure = await signOutLocallyRegardless(logoutRequest, () => {
      setMe(null);
      setStatus("anonymous");
    });
    if (failure) console.warn("logout request failed; local session cleared anyway", failure);
  }, []);

  const value = useMemo<DashboardAuthValue>(
    () => ({ status, me, refresh, signOut }),
    [status, me, refresh, signOut],
  );

  return (
    <DashboardAuthReactContext.Provider value={value}>{children}</DashboardAuthReactContext.Provider>
  );
}

export function useDashboardAuth(): DashboardAuthValue {
  const value = useContext(DashboardAuthReactContext);
  if (!value) {
    throw new Error("useDashboardAuth: must be used inside <DashboardAuthProvider>");
  }
  return value;
}
