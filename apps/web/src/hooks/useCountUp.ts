import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../theme.js";

/**
 * Animates a number from 0 up to `target` once, for the stat cards. Pure
 * presentation: the value shown mid-animation is never read by anything else
 * and the final value is exactly `target`. Viewers who asked for reduced
 * motion get `target` immediately with no tween.
 */
export function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const from = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic — fast then settling, matching the UI easing.
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (target - from) * eased);
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else setValue(target);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [target, durationMs]);

  return value;
}
