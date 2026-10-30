/**
 * The FilsPay brand lockup: an inline-SVG coin/chip mark plus the "FilsPay"
 * wordmark. Pure presentation — no external image and no CDN (the hosted box
 * is offline), so the whole mark ships as vector markup that stays crisp at
 * any size and in either colour scheme.
 *
 * `tone="light"` draws the wordmark in white for the navy top bar;
 * `tone="ink"` (default) draws it in brand ink for light surfaces such as the
 * checkout header.
 */
export function Logo({ tone = "ink", size = 26 }: { tone?: "light" | "ink"; size?: number }) {
  const wordColor = tone === "light" ? "#ffffff" : "var(--fp-heading)";
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
          {/* The brand teal→emerald gradient, rendered into the coin disc. */}
          <linearGradient id="fp-coin" x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--fp-accent)" />
            <stop offset="1" stopColor="var(--fp-accent-2)" />
          </linearGradient>
        </defs>
        <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="var(--fp-ink)" />
        {/* abstract coin: an off-centre teal→emerald disc with a stylised "f" cut */}
        <circle cx="16" cy="16" r="9.5" fill="url(#fp-coin)" />
        {/* a slow highlight sweeping across the coin — the signature shine */}
        <circle className="fp-logo-shine" cx="12.5" cy="12.5" r="3.2" fill="#ffffff" opacity="0.28" />
        <path
          d="M19 10.3h-2.4c-1.6 0-2.7 1.05-2.7 2.75V14h-1.7v2.4h1.7V22h2.5v-5.6h2.2V14h-2.2v-0.7c0-0.6 0.35-0.95 0.95-0.95H19z"
          fill="#ffffff"
        />
      </svg>
      <span className="fp-logo-word" style={{ color: wordColor }}>
        Fils<span className="fp-logo-word-accent">Pay</span>
      </span>
    </span>
  );
}
