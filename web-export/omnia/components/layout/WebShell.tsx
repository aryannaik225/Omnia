"use client";
/**
 * The web app's shell, mirroring the desktop's (src/App.tsx → Shell): ambient bleed, the Liquid
 * Glass sidebar (tab bar on phones), the sticky filter bar, one scrolling <main> with per-view
 * scroll memory and "tap the current tab again to go to the top", the detail modal and toasts.
 *
 * Views are Next routes; the store gets the router so the ported components can `navigate`.
 * The open title is mirrored into `?t=movie:603`, so a title can be shared or reloaded.
 */
import { domMax, LazyMotion, m, MotionConfig } from "framer-motion";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { PHONE_QUERY, useMediaQuery, useRafCallback } from "../../lib/hooks";
import { SCROLL_TOP_EVENT } from "../../lib/scrollTop";
import { registerRouter, useAppStore } from "../../store/useAppStore";
import { Toasts } from "../common/Toasts";
import { MediaDetailModal } from "../modals/MediaDetailModal";
import { AmbientBackground } from "./AmbientBackground";
import { LiquidSidebar, SIDEBAR_COLLAPSED, SIDEBAR_EXPANDED } from "./LiquidSidebar";
import { MobileTabBar } from "./MobileTabBar";
import { TopFilterBar } from "./TopFilterBar";

const TITLE_PARAM = /^(movie|tv):(\d{1,9})$/;

/** Keeps `?t=` in step with the detail modal (and opens it from a shared link). */
function useTitleParam() {
  const stack = useAppStore((s) => s.modalStack);
  const params = useSearchParams();
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const m = TITLE_PARAM.exec(params.get("t") ?? "");
    if (m) useAppStore.getState().openTitle({ id: Number(m[2]), mediaType: m[1] as "movie" | "tv" });
    // Only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const top = stack.filter((e) => e.kind === "title").pop();
  const value = top && top.kind === "title" ? `${top.mediaType}:${top.id}` : null;
  useEffect(() => {
    if (!opened.current) return;
    const url = new URL(window.location.href);
    if ((url.searchParams.get("t") ?? null) === value) return;
    if (value) url.searchParams.set("t", value);
    else url.searchParams.delete("t");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [value]);
}

export function WebShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const boot = useAppStore((s) => s.boot);
  const regionReady = useAppStore((s) => s.regionReady);
  const pinned = useAppStore((s) => s.sidebarPinned);
  const view = useAppStore((s) => s.view);
  const rememberScroll = useAppStore((s) => s.rememberScroll);
  const closeModals = useAppStore((s) => s.closeModals);
  const main = useRef<HTMLElement | null>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  useTitleParam();

  useEffect(() => {
    registerRouter((href) => router.push(href, { scroll: false }));
    boot();
  }, [router, boot]);

  // URL → view (sidebar state, hub, browse target, search query).
  const search = params.toString();
  useEffect(() => {
    useAppStore.getState().syncRoute(path, new URLSearchParams(search));
  }, [path, search]);

  // Per-route scroll memory: restore where you were when you come back to a view.
  const scrollKey = path;
  const restoring = useRef(false);
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    // Changing view closes the detail modal (not on first load: a shared ?t= link opens it).
    if (lastKey.current !== null && lastKey.current !== scrollKey) closeModals();
    lastKey.current = scrollKey;
    const top = useAppStore.getState().scrollPositions[scrollKey] ?? 0;
    restoring.current = true;
    main.current?.scrollTo({ top });
    // Content streams in over a few frames: apply it again once the view has laid out.
    const t = setTimeout(() => {
      main.current?.scrollTo({ top });
      restoring.current = false;
    }, 350);
    return () => clearTimeout(t);
  }, [scrollKey, closeModals]);

  // Re-clicking the open view in the sidebar / tab bar scrolls back to the top.
  useEffect(() => {
    const toTop = () => {
      restoring.current = false;
      main.current?.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener(SCROLL_TOP_EVENT, toTop);
    return () => window.removeEventListener(SCROLL_TOP_EVENT, toTop);
  }, []);

  const onScroll = useRafCallback(() => {
    if (!restoring.current) rememberScroll(scrollKey, main.current?.scrollTop ?? 0);
  });

  // Hover-expansion floats over the content; only a pinned sidebar reserves its full width.
  const contentLeft = phone ? 16 : (pinned ? SIDEBAR_EXPANDED : SIDEBAR_COLLAPSED) + 32;
  const style = { "--content-left": `${contentLeft}px`, "--content-right": phone ? "16px" : "32px" } as CSSProperties;
  const fullBleed = view === "home";

  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <div className="omnia-app">
          <AmbientBackground />
          {phone ? <MobileTabBar /> : <LiquidSidebar />}
          <main
            ref={main}
            onScroll={onScroll}
            className={`h-full overflow-y-auto overflow-x-hidden ${phone ? "pb-[calc(84px+env(safe-area-inset-bottom))]" : ""}`}
            style={style}
          >
            {/* In-flow sticky header: 16px from the top like the sidebar, so it never covers the hero. */}
            <header
              className="sticky top-4 z-30 mt-4 transition-[padding] duration-500"
              style={{ paddingLeft: "var(--content-left)", paddingRight: "var(--content-right)", marginTop: phone ? "max(16px, env(safe-area-inset-top))" : undefined }}
            >
              <TopFilterBar />
            </header>
            <m.div
              key={path}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
              className={fullBleed ? "pt-4" : "pt-6 transition-[padding] duration-500"}
              style={fullBleed ? undefined : { paddingLeft: "var(--content-left)", paddingRight: "var(--content-right)" }}
            >
              {regionReady ? children : <div className={`skeleton rounded-panel ${fullBleed ? "h-[68vh] min-h-[520px] max-md:h-[60vh] max-md:min-h-[420px]" : "mt-10 h-[40vh]"}`} />}
            </m.div>
          </main>
          <MediaDetailModal />
          <Toasts />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
