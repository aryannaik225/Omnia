/**
 * Omnia app shell: boot → "Who's watching?" → Liquid Glass catalog (ambient bleed, collapsible
 * sidebar, filter bar, views, detail modal, account sync), wired to the Rust backend events.
 */
import { AnimatePresence, domMax, LazyMotion, m, MotionConfig } from "framer-motion";
import { lazy, Suspense, useEffect, useRef, type CSSProperties } from "react";
import { PHONE_QUERY, useMediaQuery, useRafCallback } from "./lib/hooks";
import { handleNavKey, setBackHandler, setHomeHandler, startSpatialNavigation, type NavKey } from "./lib/spatialNav";
import { useHandoff } from "./services/handoff";
import { NotPairedError, platformMode, remoteControl, tvNavigation, UNPAIRED_EVENT } from "./services/platform";
import { events, isTauri } from "./services/tauriBridge";
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
import { HandoffSheet } from "./components/modals/HandoffSheet";
import { MobileTabBar } from "./components/layout/MobileTabBar";
import { TvConnecting, TvPairing, useTvConnection } from "./components/tv/TvConnect";
import { isVirtualKeyboardOpen, VirtualKeyboard, VK_CLOSE_EVENT } from "./components/tv/VirtualKeyboard";
import wordmark from "./assets/omnia-wordmark.png";

// Secondary screens load on demand to keep the startup bundle small.
const SettingsView = lazy(() => import("./components/settings/SettingsView").then((mod) => ({ default: mod.SettingsView })));
const CollectionsView = lazy(() => import("./components/views/CollectionsView").then((mod) => ({ default: mod.CollectionsView })));
const HubsView = lazy(() => import("./components/views/HubsView").then((mod) => ({ default: mod.HubsView })));
const RemoteView = lazy(() => import("./components/views/RemoteView").then((mod) => ({ default: mod.RemoteView })));
const DevStreamPlayer = lazy(() => import("./components/modals/DevStreamPlayer").then((mod) => ({ default: mod.DevStreamPlayer })));
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
    case "remote":
      return <RemoteView />;
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
  const phone = useMediaQuery(PHONE_QUERY);

  // Hover-expansion floats over the content; only a pinned sidebar reserves its full width.
  // Phones: no sidebar (bottom tab bar instead) and a 16 px gutter.
  const contentLeft = phone ? 16 : (pinned ? SIDEBAR_EXPANDED : SIDEBAR_COLLAPSED) + 32;
  const style = { "--content-left": `${contentLeft}px`, "--content-right": phone ? "16px" : "32px" } as CSSProperties;
  const fullBleed = view === "home";

  return (
    <>
      {phone ? <MobileTabBar /> : <LiquidSidebar />}
      <main ref={main} onScroll={onScroll} className={`h-full overflow-y-auto overflow-x-hidden ${phone ? "pb-[calc(84px+env(safe-area-inset-bottom))]" : ""}`} style={style}>
        {/* In-flow sticky header: 16px from the top like the sidebar, so it never covers the hero. */}
        <header className="sticky top-4 z-30 mt-4 transition-[padding] duration-500" style={{ paddingLeft: "var(--content-left)", paddingRight: "var(--content-right)", marginTop: phone ? "max(16px, env(safe-area-inset-top))" : undefined }}>
          <TopFilterBar />
        </header>
        <AnimatePresence mode="wait">
          <m.div
            key={view}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
            className={fullBleed ? "pt-4" : "pt-6 transition-[padding] duration-500"}
            style={fullBleed ? undefined : { paddingLeft: "var(--content-left)", paddingRight: "var(--content-right)" }}
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
        <DevStreamPlayer />
      </Suspense>
      <HandoffSheet />
    </>
  );
}

function Splash({ message, error = false }: { message: string; error?: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <m.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} className="glass-panel w-[min(420px,calc(100vw-32px))] px-8 py-7 text-center">
        <h1>
          <img src={wordmark} alt="Omnia" draggable={false} className="mx-auto h-12 w-auto" />
        </h1>
        <p className={`mt-2 ${error ? "text-[#ff6961]" : "text-label-secondary"}`}>{message}</p>
      </m.div>
    </div>
  );
}

/** The remote's / phone's Back: close the top layer, else go Home; false at the root. */
function appBack(): boolean {
  if (isVirtualKeyboardOpen()) {
    window.dispatchEvent(new Event(VK_CLOSE_EVENT));
    return true;
  }
  if (useHandoff.getState().pending) {
    useHandoff.getState().clear();
    return true;
  }
  const player = usePlayerStore.getState();
  if (player.picker) {
    player.closePicker();
    return true;
  }
  const s = useAppStore.getState();
  if (s.accountSyncOpen) {
    s.setAccountSyncOpen(false);
    return true;
  }
  if (s.modalStack.length) {
    s.popModal();
    return true;
  }
  if (s.view === "hubs" && s.activeHub) {
    s.navigate("hubs", { hub: null });
    return true;
  }
  if (s.view !== "home" && !s.profileGateOpen) {
    s.navigate("home");
    return true;
  }
  return false;
}

export default function App() {
  const tv = useTvConnection();
  // The TV client shows its own connect / pair screens until the PC answers.
  if (platformMode === "tv" && !tv.ready) {
    return (
      <LazyMotion features={domMax} strict>
        <AmbientBackground />
        {tv.server ? <TvConnecting server={tv.server} onReady={tv.onReady} onForget={tv.forget} /> : <TvPairing onPaired={tv.paired} />}
        <TvChrome />
      </LazyMotion>
    );
  }
  return <Main onUnpaired={tv.forget} />;
}

const goHome = () => {
  const s = useAppStore.getState();
  if (s.profileGateOpen) return;
  s.closeModals();
  s.setAccountSyncOpen(false);
  s.navigate("home");
};

/**
 * D-pad navigation and the on-screen keyboard (TV mode), and the phone remote's keys: the PC
 * gets them as a desktop event, the TV picks them up from the PC (long-poll).
 */
function TvChrome({ remoteKeys = false }: { remoteKeys?: boolean }) {
  useEffect(() => {
    setBackHandler(appBack);
    setHomeHandler(goHome);
    if (!tvNavigation) return;
    return startSpatialNavigation();
  }, []);

  useEffect(() => {
    if (!remoteKeys) return;
    if (platformMode === "desktop") {
      let off: (() => void) | undefined;
      let cancelled = false;
      void events.onRemoteKey(({ key }) => handleNavKey(key as NavKey)).then((fn) => (cancelled ? fn() : (off = fn)));
      return () => {
        cancelled = true;
        off?.();
      };
    }
    if (platformMode !== "tv") return;
    const ctrl = new AbortController();
    void (async () => {
      let failures = 0;
      while (!ctrl.signal.aborted) {
        try {
          const key = await remoteControl.poll(ctrl.signal);
          failures = 0;
          if (key) handleNavKey(key);
        } catch (e) {
          if (ctrl.signal.aborted || e instanceof NotPairedError) return;
          failures++;
          await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * failures)));
        }
      }
    })();
    return () => ctrl.abort();
  }, [remoteKeys]);

  return tvNavigation ? <VirtualKeyboard /> : null;
}

function Main({ onUnpaired }: { onUnpaired: () => void }) {
  const booted = useAppStore((s) => s.booted);
  const bootError = useAppStore((s) => s.bootError);
  const gateOpen = useAppStore((s) => s.profileGateOpen);
  const bootstrap = useAppStore((s) => s.bootstrap);
  const initListeners = usePlayerStore((s) => s.initListeners);
  const inTauri = isTauri();

  // A revoked phone goes back to the pairing screen; a revoked TV forgets the PC.
  useEffect(() => {
    if (platformMode === "desktop") return;
    const on = () => (platformMode === "lan" ? window.location.replace("/pair") : onUnpaired());
    window.addEventListener(UNPAIRED_EVENT, on);
    return () => window.removeEventListener(UNPAIRED_EVENT, on);
  }, [onUnpaired]);

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
        <TvChrome remoteKeys={booted && !bootError} />
      </MotionConfig>
    </LazyMotion>
  );
}
