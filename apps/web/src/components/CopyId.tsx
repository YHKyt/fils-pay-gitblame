import { useEffect, useState } from "react";

/**
 * A short, human-scale rendering of a long id (`Ref #FE367882`,
 * `acq_…3a8cf0d`) with a copy button. The full value is never dropped: it is
 * the chip's hover title and exactly what the button copies, so support can
 * still paste the real id into a ticket or an API call.
 */
export function CopyId({
  display,
  value,
  label,
}: {
  /** What is shown on screen. */
  display: string;
  /** The full id, shown on hover and copied. */
  value: string;
  /** What the id is, for the hover title and the button's accessible name. */
  label: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // No clipboard permission (or no secure context). The full value is
      // still in the title, so there is nothing to recover from.
      setCopied(false);
    }
  }

  return (
    <span className="dash-id-chip" title={`${label}: ${value}`}>
      <code>{display}</code>
      <button
        type="button"
        className="dash-id-copy"
        onClick={() => void copy()}
        aria-label={`Copy ${label.toLowerCase()}`}
        title={`Copy full ${label.toLowerCase()}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
