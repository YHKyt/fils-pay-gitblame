/**
 * The FilsPay brand lockup for the "Pearl of the Gulf" identity: an inline-SVG
 * fils-coin mark — a brushed-gold coin set on a petrol tile, lit by a single
 * pearl highlight — beside the "FilsPay" wordmark in the display serif. Pure
 * presentation: no external image and no CDN (the hosted box is offline), so
 * the whole mark ships as vector markup that stays crisp at any size and in
 * either colour scheme. A slow sheen sweeps the coin — the signature shine.
 *
 * `tone="light"` draws the wordmark in pearl white for the petrol top bar;
 * `tone="ink"` (default) draws it in brand ink for pearl surfaces such as the
 * checkout header.
 */
export function Logo({ tone = "ink", size = 26 }: { tone?: "light" | "ink"; size?: number }) {
  const wordColor = tone === "light" ? "#faf6ec" : "var(--fp-heading)";
  return (
    <span className="fp-logo" aria-label="FilsPay" role="img">
      <svg
        className="fp-logo-mark"
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {/* Struck brass: a diagonal gold sweep with a bright crown. */}
          <linearGradient id="fp-coin" x1="7" y1="6" x2="25" y2="27" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#f0d488" />
            <stop offset="0.5" stopColor="#d8b253" />
            <stop offset="1" stopColor="#b8902f" />
          </linearGradient>
          <radialGradient id="fp-pearl" cx="0.35" cy="0.3" r="0.75">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.6" stopColor="#f3ecd8" />
            <stop offset="1" stopColor="#d9c38a" />
          </radialGradient>
        </defs>
        {/* Petrol tile backing. */}
        <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="var(--fp-ink)" />
        <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="none" stroke="rgba(230,200,119,0.28)" strokeWidth="1" />
        {/* The brushed-gold fils coin with a fine reeded edge. */}
        <circle cx="16" cy="16" r="9.6" fill="url(#fp-coin)" />
        <circle cx="16" cy="16" r="9.6" fill="none" stroke="#8a6a20" strokeWidth="0.6" opacity="0.5" />
        <circle cx="16" cy="16" r="7.7" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="0.6" />
        {/* A single pearl set into the coin — the Gulf's pearl. */}
        <circle cx="13" cy="12.6" r="2.2" fill="url(#fp-pearl)" />
        {/* The slow travelling highlight — the signature shine. */}
        <circle className="fp-logo-shine" cx="12.5" cy="12.5" r="3" fill="#ffffff" opacity="0.26" />
        {/* The "f" of fils, cut in deep petrol against the gold. */}
        <path
          d="M19.4 11.1h-2.5c-1.65 0-2.8 1.08-2.8 2.84V15h-1.75v2.45h1.75V22h2.55v-4.55h2.25V15h-2.25v-0.72c0-0.62 0.36-0.98 0.98-0.98h1.99z"
          fill="var(--fp-ink-900)"
        />
      </svg>
      <span className="fp-logo-word" style={{ color: wordColor }}>
        Fils<span className="fp-logo-word-accent">Pay</span>
      </span>
    </span>
  );
}
