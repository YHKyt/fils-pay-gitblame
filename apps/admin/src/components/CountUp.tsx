import { useEffect, useRef, useState } from "react";

/**
 * Animates a numeric figure counting up to its final value on mount. Purely
 * presentational: it displays the exact same number the console already
 * computed, only easing into it. The caller passes the final numeric
 * `value` and a `format` function so the count-up stays in the page's own
 * formatting (e.g. BHD money). Honours prefers-reduced-motion by snapping
 * straight to the final value.
 */
export function CountUp({
  value,
  format,
  durationMs = 850,
  className,
}: {
  value: number;
  format: (n: number) => string;
  durationMs?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState<number>(value);
  const rafRef = useRef<number | null>(null);
  const fromRef = useRef<number>(0);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced || !Number.isFinite(value)) {
      setDisplay(value);
      return;
    }

    const from = fromRef.current;
    const start = performance.now();
    // easeOutCubic
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);

    function tick(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      setDisplay(from + (value - from) * ease(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      fromRef.current = value;
    };
  }, [value, durationMs]);

  return <span className={className}>{format(display)}</span>;
}
