import { setTheme, useTheme } from "../theme.js";

/**
 * Light/dark toggle. Presentation only: it writes the viewer's choice to
 * localStorage and flips <html data-theme>, which the tokens.css palette reads.
 * With no choice ever made the app follows the OS; this is a per-viewer
 * override, never sent anywhere.
 */
export function ThemeToggle() {
  const { resolved } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="fp-theme-toggle"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {resolved === "dark" ? (
        /* Sun — offer to go light. */
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12 2.2v2.4M12 19.4v2.4M2.2 12h2.4M19.4 12h2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" />
          </g>
        </svg>
      ) : (
        /* Moon — offer to go dark. */
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M20 14.5A8 8 0 0 1 9.5 4a0.6 0.6 0 0 0-0.82-0.72A9 9 0 1 0 20.7 15.3 0.6 0.6 0 0 0 20 14.5z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}
