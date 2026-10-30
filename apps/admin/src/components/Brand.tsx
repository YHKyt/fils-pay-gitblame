/**
 * The FilsPay wordmark, shared by the top bar and the login card so the
 * admin console carries the same mark as the merchant dashboard. Inline SVG
 * only — no external image or font is fetched. The small "Admin" badge makes
 * it unmistakable that this is the operations console, not the dashboard.
 *
 * Presentation only: this renders a logo and carries no behaviour.
 */
export function Brand({ badge = true }: { badge?: boolean }) {
  return (
    <div className="admin-brand">
      <svg
        className="admin-brand-mark"
        width="28"
        height="28"
        viewBox="0 0 32 32"
        role="img"
        aria-label="FilsPay"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="fp-mark-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#15d1c0" />
            <stop offset="1" stopColor="#10b981" />
          </linearGradient>
        </defs>
        {/* Rounded tile in the FilsPay aurora gradient, the "F" of Fils, and
            the fils-coin dot — the shared brand motif. */}
        <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#fp-mark-grad)" />
        <rect
          x="1"
          y="1"
          width="30"
          height="30"
          rx="9"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.22"
        />
        <path d="M11 9h11v3.4h-7.2v3.2H21v3.4h-6.2V23H11z" fill="#ffffff" />
        <circle cx="23" cy="10.4" r="2.3" fill="#ffffff" opacity="0.95" />
      </svg>
      <span className="admin-brand-word">FilsPay</span>
      {badge ? <span className="admin-brand-badge">Admin</span> : null}
    </div>
  );
}
