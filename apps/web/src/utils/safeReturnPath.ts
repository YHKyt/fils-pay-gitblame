/**
 * Post-login return path, normalised so it can only ever be a same-origin,
 * in-app path. The value comes from router state (`from`), which the route
 * guard fills from the current location; anything that could resolve off
 * this origin ("//host", "/\host", a scheme, control characters) or that
 * is outside the /dashboard area falls back to the default page.
 */
export function safeReturnPath(candidate: unknown, fallback: string): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 2048) return fallback;
  if (!candidate.startsWith("/")) return fallback;
  if (candidate.startsWith("//")) return fallback;
  // Browsers treat "\" like "/" in URLs, so "/\evil.example" is protocol-relative.
  if (candidate.includes("\\")) return fallback;
  // Control characters (tab/newline are stripped by the URL parser) and spaces.
  if (/[\u0000-\u0020\u007f]/.test(candidate)) return fallback;
  let resolved: URL;
  try {
    resolved = new URL(candidate, "http://app.invalid");
  } catch {
    return fallback;
  }
  if (resolved.origin !== "http://app.invalid") return fallback;
  const path = resolved.pathname + resolved.search + resolved.hash;
  if (path !== "/dashboard" && !path.startsWith("/dashboard/") && !path.startsWith("/dashboard?")) return fallback;
  return path;
}
