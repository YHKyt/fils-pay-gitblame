import { useEffect } from "react";
import { pageTitle } from "../format.js";

/** Sets the browser tab title while the page is mounted, restoring the
 *  previous title on unmount so pages without the hook are unaffected. */
export function usePageTitle(name: string | null | undefined): void {
  useEffect(() => {
    if (!name) return;
    const previous = document.title;
    document.title = pageTitle(name);
    return () => {
      document.title = previous;
    };
  }, [name]);
}
