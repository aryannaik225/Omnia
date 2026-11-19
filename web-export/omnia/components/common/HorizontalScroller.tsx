"use client";
/**
 * Horizontal row with Liquid Glass edge arrows that appear on hover, so long rows (cast, credits)
 * don't require Shift+wheel or a trackpad. Each arrow only shows while there is more content in
 * its direction.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRafCallback } from "../../lib/hooks";
import { ChevronLeftIcon, ChevronRightIcon } from "./Icons";

export function HorizontalScroller({ children, className = "row-scroller", label }: { children: ReactNode; className?: string; label?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft <= 2;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, []);
  const onScroll = useRafCallback(measure);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Children may arrive after mount (async data, lazy images).
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure]);

  const scroll = (dir: -1 | 1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: "smooth" });

  // The wrapper owns positioning: `.icon-button:hover` sets `transform`, which would clobber a
  // translate-based vertical centring on the button itself.
  const arrow = (dir: -1 | 1, hidden: boolean) => (
    <span data-nav-skip className={`pointer-events-none absolute inset-y-0 z-10 flex items-center ${dir < 0 ? "left-1" : "right-1"}`}>
      <button
        type="button"
        onClick={() => scroll(dir)}
        aria-label={dir < 0 ? `Scroll ${label ?? "row"} left` : `Scroll ${label ?? "row"} right`}
        tabIndex={hidden ? -1 : 0}
        className={`icon-button !h-10 !w-10 shadow-lift transition-opacity duration-200 ${
          hidden ? "!opacity-0" : "pointer-events-auto opacity-0 focus-visible:opacity-100 group-hover/scroller:opacity-100"
        }`}
      >
        {dir < 0 ? <ChevronLeftIcon size={18} /> : <ChevronRightIcon size={18} />}
      </button>
    </span>
  );

  return (
    <div className="group/scroller relative">
      {arrow(-1, edges.start)}
      <div ref={ref} onScroll={onScroll} className={className} aria-label={label}>
        {children}
      </div>
      {arrow(1, edges.end)}
    </div>
  );
}
