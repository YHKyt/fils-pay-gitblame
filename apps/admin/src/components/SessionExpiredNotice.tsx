import { useAdminAuth } from "../auth/AdminAuthContext.js";

/** Shown above the login screen after a 401 ended the session mid-use, so
 *  the operator knows why they are back at sign-in. */
export function SessionExpiredNotice() {
  const { sessionExpired, status } = useAdminAuth();
  if (!sessionExpired || status !== "anonymous") return null;
  return (
    <div className="admin-session-expired" role="status">
      Your session expired, please sign in again.
    </div>
  );
}
