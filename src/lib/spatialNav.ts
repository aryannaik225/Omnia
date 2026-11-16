/**
 * Spatial (D-pad) navigation for TV remotes: Up / Down / Left / Right move focus to the
 * nearest focusable element in that direction, OK (Enter) activates it, Back closes the top
 * layer. Works on any layout without per-component wiring: candidates are found geometrically,
 * limited to the topmost dialog when one is open.
 *
 * Back: Android TV's Back button walks the WebView history, so one sentinel history entry is
 * kept; each Back pops it, runs the app's back handler, and re-arms it. At the root (nothing
 * to close), it isn't re-armed, so the next Back leaves the app as Android users expect.
 */

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="button"]:not([aria-disabled="true"])';

type Dir = "up" | "down" | "left" | "right";
const KEY_DIR: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
/** Keys TV remotes send for Back (Escape on most; GoBack / BrowserBack on some WebViews). */
const BACK_KEYS = new Set(["Escape", "GoBack", "BrowserBack", "Back"]);

let backHandler: () => boolean = () => false;

/** The app's Back: close the top layer / go up a level; return false at the root. */
export function setBackHandler(fn: () => boolean) {
  backHandler = fn;
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) {
    // Off-screen elements in a scroller are still reachable (rows scroll them into view).
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.opacity !== "0";
}

/** The topmost dialog (modal, sheet, keyboard) when one is open, else the document. */
function scope(): ParentNode {
  const layers = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [data-focus-scope]')).filter(visible);
  return layers[layers.length - 1] ?? document;
}

function candidates(root: ParentNode): HTMLElement[] {
  // `data-nav-skip`: mouse-only affordances (row scroll paddles) the D-pad never needs.
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[inert], [data-nav-skip]") && visible(el));
}

/**
 * Navigation zones: the fixed sidebar / tab bar floats over the scrolling content, so geometry
 * alone would let focus jump between them (or onto cards hidden behind the expanded sidebar).
 */
type Zone = "nav" | "top" | "main";
/** `top`: the sticky filter bar, which floats over rows scrolled beneath it. */
const zoneOf = (el: Element | null): Zone => (el?.closest('nav[aria-label="Primary"]') ? "nav" : el?.closest("main > header") ? "top" : "main");

/**
 * Nearest candidate in `dir` among `list`: elements beyond the current one's edge, ranked by
 * distance along the axis plus a heavier penalty for being off-line. `sameLine` keeps
 * Left / Right in the current row (and Up / Down in the column band) instead of jumping.
 */
function nearestIn(from: DOMRect, dir: Dir, list: HTMLElement[], current: Element | null, sameLine: boolean): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  for (const el of list) {
    if (el === current || (current && (el.contains(current) || current.contains(el)))) continue;
    const r = el.getBoundingClientRect();
    if (sameLine && (dir === "left" || dir === "right") && Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top) <= 0) continue;
    const ex = r.left + r.width / 2;
    const ey = r.top + r.height / 2;
    let main: number;
    let cross: number;
    if (dir === "right" || dir === "left") {
      main = dir === "right" ? r.left - from.right : from.left - r.right;
      if ((dir === "right" ? ex <= cx : ex >= cx) || main < -from.width / 2) continue;
      const overlap = Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top);
      cross = overlap > 0 ? 0 : Math.abs(ey - cy);
    } else {
      main = dir === "down" ? r.top - from.bottom : from.top - r.bottom;
      if ((dir === "down" ? ey <= cy : ey >= cy) || main < -from.height / 2) continue;
      const overlap = Math.min(from.right, r.right) - Math.max(from.left, r.left);
      cross = overlap > 0 ? 0 : Math.abs(ex - cx);
    }
    const score = Math.max(0, main) + cross * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/**
 * Zone rules: Up / Down stay in their zone. In the content, Left / Right stay in the row; past
 * the row's left edge focus enters the sidebar. In the sidebar, Right enters the content.
 */
function nearest(from: DOMRect, dir: Dir, list: HTMLElement[], current: Element | null, zone: Zone = zoneOf(current)): HTMLElement | null {
  const inZone = (z: Zone) => list.filter((el) => zoneOf(el) === z);
  const [nav, top, main] = [inZone("nav"), inZone("top"), inZone("main")];
  if (dir === "up" || dir === "down") {
    if (zone === "nav") return nearestIn(from, dir, nav, current, false);
    if (zone === "top") return dir === "down" ? nearestIn(from, dir, main, current, false) : null;
    // Content: the next row first; the top bar only above the very first row.
    return nearestIn(from, dir, main, current, false) ?? (dir === "up" ? nearestIn(from, dir, top, current, false) : null);
  }
  if (zone === "nav") return dir === "left" ? nearestIn(from, dir, nav, current, true) : nearestIn(from, dir, [...top, ...main], current, false);
  const own = zone === "top" ? top : main;
  return nearestIn(from, dir, own, current, true) ?? (dir === "left" ? nearestIn(from, dir, nav, current, false) : null);
}

/** The scrolling container around `el` (the catalog's `<main>`, a modal body…). */
function scrollerOf(el: Element | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
  }
  return null;
}

/** Where focus last was, so navigation continues from there if that element unmounts. */
let last: { rect: DOMRect; zone: Zone } | null = null;

export function focusElement(el: HTMLElement) {
  el.focus({ preventScroll: true });
  const zone = zoneOf(el);
  // Reaching the top bar means "back to the top of the page".
  if (zone === "top") el.closest("main")?.scrollTo({ top: 0, behavior: "smooth" });
  else el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  last = { rect: el.getBoundingClientRect(), zone };
}

function rememberFocus(e: FocusEvent) {
  if (e.target instanceof HTMLElement && e.target !== document.body) last = { rect: e.target.getBoundingClientRect(), zone: zoneOf(e.target) };
}

/** First thing to focus in the current layer: its autofocus / active item, else the first. */
export function focusFirst(root: ParentNode = scope()) {
  const list = candidates(root);
  const preferred = list.find((el) => el.matches('[autofocus], [aria-current="page"], [data-active="true"]')) ?? list[0];
  if (preferred) focusElement(preferred);
}

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  return !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range"].includes(el.type)));
}

/** Keys a TV remote / the phone remote sends. */
export type NavKey = Dir | "ok" | "back" | "home" | "playpause";

let homeHandler: () => void = () => {};
/** "Home" on the phone remote. */
export function setHomeHandler(fn: () => void) {
  homeHandler = fn;
}

/** Moves focus one step in `dir`; returns true if focus moved (or was placed for the first time). */
export function moveFocus(dir: Dir): boolean {
  const active = document.activeElement as HTMLElement | null;
  const root = scope();
  const list = candidates(root);
  if (!active || active === document.body || active.tagName === "IFRAME" || !(root === document || (root as Node).contains(active)) || !list.includes(active)) {
    // The focused element just unmounted (a row re-rendered): carry on from where it was.
    if (root === document && last) {
      const next = nearest(last.rect, dir, list, null, last.zone) ?? nearest(last.rect, dir === "down" ? "up" : dir === "up" ? "down" : dir, list, null, last.zone);
      if (next) {
        focusElement(next);
        return true;
      }
    }
    // Nothing focused yet: start at the layer's natural first item.
    const before = document.activeElement;
    focusFirst(root);
    return document.activeElement !== before;
  }
  const next = nearest(active.getBoundingClientRect(), dir, list, active);
  if (next) {
    focusElement(next);
    return true;
  }
  // Nothing loaded further down / up yet (rows mount lazily as they near the viewport):
  // scroll the page that way, then look again once the next rows have rendered.
  if ((dir === "down" || dir === "up") && zoneOf(active) === "main") {
    const scroller = scrollerOf(active);
    if (!scroller) return false;
    const before = scroller.scrollTop;
    scroller.scrollBy({ top: (dir === "down" ? 1 : -1) * scroller.clientHeight * 0.6, behavior: "smooth" });
    setTimeout(() => {
      if (document.activeElement !== active || Math.abs(scroller.scrollTop - before) < 2) return;
      const later = nearest(active.getBoundingClientRect(), dir, candidates(scope()), active);
      if (later) focusElement(later);
    }, 650);
  }
  return false;
}

/** The biggest playing / paused video on screen (the dev test player), if any. */
function screenVideo(): HTMLVideoElement | null {
  const vs = Array.from(document.querySelectorAll("video")).filter((v) => visible(v));
  vs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  return vs[0] ?? null;
}

/** One remote key, from the TV's D-pad or the phone remote. */
export function handleNavKey(key: NavKey) {
  document.documentElement.classList.add("tv-nav");
  switch (key) {
    case "up":
    case "down":
    case "left":
    case "right":
      moveFocus(key);
      return;
    case "ok": {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) active.click();
      else focusFirst();
      return;
    }
    case "back":
      backHandler();
      return;
    case "home":
      homeHandler();
      return;
    case "playpause": {
      const v = screenVideo();
      if (v) void (v.paused ? v.play() : v.pause());
      return;
    }
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const active = document.activeElement as HTMLElement | null;

  if (BACK_KEYS.has(e.key)) {
    if (backHandler()) e.preventDefault();
    return;
  }
  if (e.key === "MediaPlayPause") {
    e.preventDefault();
    handleNavKey("playpause");
    return;
  }

  const dir = KEY_DIR[e.key];
  if (dir) {
    // Inside a text field, Left / Right move the caret until it reaches an edge.
    if (isTextField(active) && (dir === "left" || dir === "right")) {
      const { selectionStart: s, selectionEnd: t, value } = active;
      if (s !== null && t !== null && s === t && ((dir === "left" && s > 0) || (dir === "right" && t < value.length))) return;
    }
    // Always ours: never let the browser scroll the page instead (also at an edge, where focus
    // simply stays put). Rows and pages scroll by following the focused element.
    e.preventDefault();
    e.stopPropagation();
    moveFocus(dir);
    return;
  }

  // OK on a focusable that isn't natively clickable (a <div role=button tabindex=0>).
  if ((e.key === "Enter" || e.key === " ") && active && !isTextField(active) && !(active instanceof HTMLButtonElement) && !(active instanceof HTMLAnchorElement)) {
    if (active.matches('[role="button"], [tabindex]')) {
      e.preventDefault();
      active.click();
    }
  }
}

function armBack() {
  history.pushState({ omniaBack: true }, "");
}

function onPopState() {
  if (backHandler()) armBack();
}

/** Starts D-pad navigation; returns a cleanup function. */
export function startSpatialNavigation(): () => void {
  document.documentElement.classList.add("tv-nav");
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("popstate", onPopState);
  window.addEventListener("focusin", rememberFocus);
  armBack();
  return () => {
    document.documentElement.classList.remove("tv-nav");
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener("focusin", rememberFocus);
  };
}
