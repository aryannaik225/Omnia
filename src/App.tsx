/**
 * Omnia app shell: boot → "Who's watching?" → Liquid Glass catalog (ambient bleed, collapsible
 * sidebar, filter bar, views, detail modal, account sync), wired to the Rust backend events.
 */
import { AnimatePresence, domMax, LazyMotion, m, MotionConfig } from "framer-motion";
import { lazy, Suspense, useEffect, useRef, type CSSProperties } from "react";
import { useRafCallback } from "./lib/hooks";
import { isTauri } from "./services/tauriBridge";
import { useAppStore, type View } from "./store/useAppStore";
import { usePlayerStore } from "./store/usePlayerStore";
import { Toasts } from "./components/common/Toasts";
import { AmbientBackground } from "./components/layout/AmbientBackground";
import { LiquidSidebar, SIDEBAR_COLLAPSED, SIDEBAR_EXPANDED } from "./components/layout/LiquidSidebar";
import { TopFilterBar } from "./components/layout/TopFilterBar";
import { MediaDetailModal } from "./components/modals/MediaDetailModal";
import { OttPickerModal } from "./components/modals/OttPickerModal";
import { ProfileGate } from "./components/profile/ProfileGate";
import { ContinueWatchingView, MyOttsView, SearchView, WatchlistView } from "./components/views/BrowseViews";
import { HomeView } from "./components/views/HomeView";
import wordmark from "./assets/omnia-wordmark.png";

// Secondary screens load on demand to keep the startup bundle small.
const SettingsView = lazy(() => import("./components/settings/SettingsView").then((mod) => ({ default: mod.SettingsView })));
const CollectionsView = lazy(() => import("./components/views/CollectionsView").then((mod) => ({ default: mod.CollectionsView })));
const HubsView = lazy(() => import("./components/views/HubsView").then((mod) => ({ default: mod.HubsView })));
const AccountSyncModal = lazy(() => import("./components/modals/AccountSyncModal").then((mod) => ({ default: mod.AccountSyncModal })));

function CurrentView({ view }: { view: View }) {
  switch (view) {
    case "home":
      return <HomeView />;
    case "search":
      return <SearchView />;
    case "continue":
      return <ContinueWatchingView />;
    case "myotts":
      return <MyOttsView />;
    case "hubs":
      return <HubsView />;
    case "watchlist":
      return <WatchlistView />;
    case "collections":
      return <CollectionsView />;
    case "settings":
      return <SettingsView />;
  }
}

function Shell() {
  const view = useAppStore((s) => s.view);
  const activeHub = useAppStore((s) => s.activeHub);
  const pinned = useAppStore((s) => s.sidebarPinned);
  const rememberScroll = useAppStore((s) => s.rememberScroll);
  const profileId = useAppStore((s) => s.activeProfile?.profileId);
  const refreshMappings = usePlayerStore((s) => s.refreshMappings);
  const refreshStatus = usePlayerStore((s) => s.refreshStatus);
  const main = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void refreshMappings();
    void refreshStatus();
  }, [profileId, refreshMappings, refreshStatus]);

  // Restore the exact scroll position per view (e.g. after "Back to Hub").
  useEffect(() => {
    const top = useAppStore.getState().scrollPositions[view] ?? 0;
    main.current?.scrollTo({ top });
  }, [view, activeHub]);

  const onScroll = useRafCallback(() => rememberScroll(view, main.current?.scrollTop ?? 0));

  // Hover-expansion floats over the content; only a pinned sidebar reserves its full width.
  const contentLeft = (pinned ? SIDEBAR_EXPANDED : SIDEBAR_COLLAPSED) + 32;
  const style = { "--content-left": `${contentLeft}px` } as CSSProperties;
  const fullBleed = view === "home";

  return (
    <>
      <LiquidSidebar />
      <main ref={main} onScroll={onScroll} className="h-full overflow-y-auto overflow-x-hidden" style={style}>
        {/* In-flow sticky header: 16px from the top like the sidebar, so it never covers the hero. */}
        <header className="sticky top-4 z-30 mt-4 pr-8 transition-[padding] duration-500" style={{ paddingLeft: "var(--content-left)" }}>
          <TopFilterBar />
        </header>
        <AnimatePresence mode="wait">
          <m.div
            key={view}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
            className={fullBleed ? "pt-4" : "pr-8 pt-6 transition-[padding] duration-500"}
            style={fullBleed ? undefined : { paddingLeft: "var(--content-left)" }}
          >
            <Suspense fallback={<div className="skeleton mt-10 h-[40vh] rounded-panel" />}>
              <CurrentView view={view} />
            </Suspense>
          </m.div>
        </AnimatePresence>
      </main>
      <MediaDetailModal />
      <OttPickerModal />
      <Suspense fallback={null}>
        <AccountSyncModal />
      </Suspense>
    </>
  );
}

function Splash({ message, error = false }: { message: string; error?: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <m.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} className="glass-panel w-[420px] px-8 py-7 text-center">
        <h1>
          <img src={wordmark} alt="Omnia" draggable={false} className="mx-auto h-12 w-auto" />
        </h1>
        <p className={`mt-2 ${error ? "text-[#ff6961]" : "text-label-secondary"}`}>{message}</p>
      </m.div>
    </div>
  );
}

export default function App() {
  const booted = useAppStore((s) => s.booted);
  const bootError = useAppStore((s) => s.bootError);
  const gateOpen = useAppStore((s) => s.profileGateOpen);
  const bootstrap = useAppStore((s) => s.bootstrap);
  const initListeners = usePlayerStore((s) => s.initListeners);
  const inTauri = isTauri();

  useEffect(() => {
    if (!inTauri) return;
    void bootstrap();
    let off: (() => void) | undefined;
    let cancelled = false;
    void initListeners().then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [inTauri, bootstrap, initListeners]);

  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <AmbientBackground />
        {!inTauri ? (
          <Splash message="Omnia's backend is only available inside the desktop app." error />
        ) : !booted ? (
          <Splash message="Opening your local library…" />
        ) : bootError ? (
          <Splash message={bootError} error />
        ) : gateOpen ? (
          <ProfileGate />
        ) : (
          <Shell />
        )}
        <Toasts />
      </MotionConfig>
    </LazyMotion>
  );
}
