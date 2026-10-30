/**
 * Theme preference for both halves of the app (dashboard + checkout).
 *
 * Presentation only — this never touches data, routes or API calls. It stores
 * the viewer's explicit light/dark choice in localStorage and reflects it onto
 * <html data-theme="…">. With no stored choice the attribute is absent and the
 * page follows the OS via the prefers-color-scheme rules in tokens.css, so the
 * default experience is unchanged; the toggle is an opt-in override on top.
 */
import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark";
export type ThemeSetting = ThemeChoice | "system";

const STORAGE_KEY = "fp-theme";
const listeners = new Set<() => void>();

function readStored(): ThemeSetting {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Private mode / blocked storage — fall through to system default.
  }
  return "system";
}

/** Reflects the stored choice onto the document root. Called once at startup
 *  (before React renders, to avoid a flash) and on every change. */
export function applyStoredTheme(): void {
  const setting = readStored();
  const root = document.documentElement;
  if (setting === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", setting);
  }
}

export function setTheme(setting: ThemeSetting): void {
  try {
    if (setting === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, setting);
  } catch {
    // Still apply for this page view even if the choice can't be persisted.
  }
  applyStoredTheme();
  listeners.forEach((fn) => fn());
}

/** The effective light/dark, resolving "system" against the OS preference. */
export function resolveTheme(setting: ThemeSetting): ThemeChoice {
  if (setting === "light" || setting === "dark") return setting;
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystem = (): void => fn();
  mql?.addEventListener?.("change", onSystem);
  return () => {
    listeners.delete(fn);
    mql?.removeEventListener?.("change", onSystem);
  };
}

/** React binding: the current stored setting and its resolved light/dark. */
export function useTheme(): { setting: ThemeSetting; resolved: ThemeChoice } {
  const setting = useSyncExternalStore(subscribe, readStored, () => "system" as ThemeSetting);
  return { setting, resolved: resolveTheme(setting) };
}

/** True when the viewer has asked the OS for reduced motion. Used to skip
 *  JS-driven effects (count-up, chart draw) for those viewers. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
