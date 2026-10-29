/**
 * Logout ordering for the dashboard: ask the server to revoke the session,
 * then drop local state and leave — whether or not the server call worked.
 * A failed logout (API down, session already expired -> 401, network error)
 * must never leave the user looking signed in on a shared machine; the
 * server-side session still dies on its own TTL.
 *
 * Never throws. Returns the server error, if there was one, so the caller
 * can log it.
 */
export async function signOutLocallyRegardless(
  serverLogout: () => Promise<void>,
  clearLocal: () => void,
): Promise<unknown> {
  let failure: unknown = null;
  try {
    await serverLogout();
  } catch (err) {
    failure = err;
  }
  clearLocal();
  return failure;
}
