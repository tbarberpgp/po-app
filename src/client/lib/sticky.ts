import { useCallback, useRef } from "react";

/**
 * Ref for a card whose `.sticky-bar` header and `table.sticky-head` headings
 * both stay in view: the headings stick under the bar, and the bar wraps on
 * narrow screens, so its height is measured into the card's --bar-h.
 */
export function useStickyCard() {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((card: HTMLDivElement | null) => {
    observer.current?.disconnect();
    const bar = card?.querySelector<HTMLElement>(".sticky-bar");
    if (!card || !bar) return;
    observer.current = new ResizeObserver(() => card.style.setProperty("--bar-h", `${bar.offsetHeight}px`));
    observer.current.observe(bar);
  }, []);
}
