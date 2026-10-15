import { useCallback, useRef } from "react";

/**
 * Ref for a card (or page) whose `.sticky-bar` and `table.sticky-head`
 * headings both stay in view: the headings stick under the bar, and the bar
 * wraps on narrow screens, so its height is measured into --bar-h. The card
 * itself is watched, not the bar, because many bars only render once the
 * list has loaded — and the card resizes when they do.
 */
export function useStickyCard() {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((card: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!card) return;
    observer.current = new ResizeObserver(() => {
      const bar = card.querySelector<HTMLElement>(".sticky-bar");
      card.style.setProperty("--bar-h", `${bar?.offsetHeight ?? 0}px`);
    });
    observer.current.observe(card);
  }, []);
}

/**
 * Ref for the sideways-scrolling box around a table too wide for its card.
 * That box is the headings' nearest scroller, so `position: sticky` can't pin
 * them to the page — instead each heading cell is slid down on scroll so the
 * row sits under the card's `.sticky-bar` (or the topbar), never past the
 * table's last row. Pair with `<table className="float-head">`.
 */
export function useFloatingHead() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((box: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!box) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const table = box.querySelector("table");
      const head = table?.tHead;
      if (!table || !head) return;
      const bar = box.closest(".card")?.querySelector<HTMLElement>(".sticky-bar")
        ?? document.querySelector<HTMLElement>(".topbar");
      const line = bar ? bar.getBoundingClientRect().bottom : 0;
      const y = Math.min(Math.max(0, line - table.getBoundingClientRect().top), table.offsetHeight - head.offsetHeight);
      const t = y > 0 ? `translateY(${y}px)` : "";
      for (const th of head.querySelectorAll<HTMLElement>("th")) th.style.transform = t;
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(place); };
    const ro = new ResizeObserver(queue);
    ro.observe(box);
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    queue();
    cleanup.current = () => {
      ro.disconnect();
      window.removeEventListener("scroll", queue);
      window.removeEventListener("resize", queue);
      cancelAnimationFrame(frame);
    };
  }, []);
}
