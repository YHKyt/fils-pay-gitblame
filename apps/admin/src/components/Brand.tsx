/**
 * The FilsPay wordmark, shared by the top bar and the login card so the
 * admin console carries the same mark as the merchant dashboard. Inline SVG
 * only — no external image or font is fetched.
 *
 * The mark is the "Pearl of the Gulf" fils-coin: a brushed brass-gold tile
 * with a soft radial sheen, a pearl-white coin face carrying the "F" of
 * Fils, and a small raised fils-coin dot. A gold sheen sweeps across it on
 * mount (CSS, transform/opacity only; disabled under prefers-reduced-motion).
 * The small "Admin" badge makes it unmistakable that this is the operations
 * console, not the dashboard.
 *
 * Presentation only: this renders a logo and carries no behaviour.
 */
export function Brand({ badge = true }: { badge?: boolean }) {
  return (
    <div className="admin-brand">
      <span className="admin-brand-logo">
        <svg
          className="admin-brand-mark"
          width="30"
          height="30"
          viewBox="0 0 32 32"
          role="img"
          aria-label="FilsPay"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            {/* Brushed brass-gold — the signature accent gradient. */}
            <linearGradient id="fp-mark-gold" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#e6c877" />
              <stop offset="0.5" stopColor="#c8a24b" />
              <stop offset="1" stopColor="#a9802c" />
            </linearGradient>
            {/* Pearl coin face. */}
            <radialGradient id="fp-mark-pearl" cx="0.35" cy="0.3" r="0.9">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.6" stopColor="#fbf6ea" />
              <stop offset="1" stopColor="#efe4cb" />
            </radialGradient>
            {/* Top-left sheen lifted over the tile. */}
            <linearGradient id="fp-mark-sheen" x1="0" y1="0" x2="0.6" y2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
              <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Rounded brass tile + its sheen and a hairline rim. */}
          <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#fp-mark-gold)" />
          <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#fp-mark-sheen)" />
          <rect
            x="1.5"
            y="1.5"
            width="29"
            height="29"
            rx="8.5"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.4"
          />

          {/* Pearl coin face with the "F" of Fils and the fils-coin dot. */}
          <circle cx="16" cy="16" r="10.4" fill="url(#fp-mark-pearl)" />
          <circle cx="16" cy="16" r="10.4" fill="none" stroke="#a9802c" strokeOpacity="0.45" />
          <path
            d="M12.4 10.4h7.4v2.5h-4.7v2.3h4.1v2.5h-4.1v3.9h-2.7z"
            fill="#0a3a40"
          />
          <circle cx="20" cy="11.1" r="1.7" fill="url(#fp-mark-gold)" stroke="#a9802c" strokeOpacity="0.5" strokeWidth="0.5" />
        </svg>
        {/* The sweeping sheen highlight (pure CSS, decorative). */}
        <span className="admin-brand-sheen" aria-hidden="true" />
      </span>
      <span className="admin-brand-word">FilsPay</span>
      {badge ? <span className="admin-brand-badge">Admin</span> : null}
    </div>
  );
}
