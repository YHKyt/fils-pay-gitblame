/**
 * After `POST /v1/admin/impersonation/:grantId/end` fails, should the
 * console forget its local record of the grant (and drop the banner)?
 *
 * Only when the server says the grant is gone for this admin: `404
 * impersonation_grant_not_found` (already ended, expired, or not theirs).
 * Any other failure — network error, 5xx, 401 — means the grant and its
 * fp_impersonation cookie may still be live, so the banner must stay up
 * with the error and the Exit button, rather than vanish and imply the
 * merchant view was closed.
 */
export function forgetGrantAfterEndFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: unknown }).statusCode === 404
  );
}
