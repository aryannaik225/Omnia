import { useCallback, useEffect, useRef, useState } from "react";

/** Debounced copy of a value (search input, filters). */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Minimal async loader keyed by `deps`; stale responses from earlier deps are discarded.
 * Pass `enabled = false` to defer (e.g. until a row scrolls into view).
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], enabled = true): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({
    data: undefined,
    error: null,
    loading: enabled,
  });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fnRef
      .current()
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((e: unknown) => !cancelled && setState({ data: undefined, error: e instanceof Error ? e.message : String(e), loading: false }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/** True once the element has come within `rootMargin` of the viewport (lazy rows, infinite grids). */
export function useInView<T extends Element>(rootMargin = "600px", once = true) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin, once]);
  return [ref, inView] as const;
}

/** Calls `fn` at most once per animation frame (scroll / pointer handlers). */
export function useRafCallback<A extends unknown[]>(fn: (...args: A) => void) {
  const frame = useRef<number | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);
  return useCallback((...args: A) => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      latest.current(...args);
    });
  }, []);
}

/** Live `matchMedia` result (e.g. the phone layout below 768 px). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Phone-width layout (bottom tab bar, tighter gutters). */
export const PHONE_QUERY = "(max-width: 767px)";
