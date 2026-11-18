/**
 * Silent update check on launch (desktop only). When GitHub Releases has a newer signed build,
 * a Liquid Glass card offers "Restart to Install"; "Later" hides it until the next launch.
 */
import { AnimatePresence, m } from "framer-motion";
import { useEffect, useState } from "react";
import { platformMode } from "../../services/platform";
import { updater, type UpdateInfo } from "../../services/tauriBridge";
import { CloseIcon } from "./Icons";

const CHECK_DELAY_MS = 4_000; // let the catalog finish booting first

export function UpdatePrompt() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (platformMode !== "desktop" || import.meta.env.DEV) return;
    let cancelled = false;
    const t = setTimeout(() => {
      updater
        .check()
        .then((u) => !cancelled && setUpdate(u))
        .catch(() => {
          /* offline / GitHub unreachable: stay silent, try again next launch */
        });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (!installing) return;
    const off = updater.onProgress(({ downloaded, total }) => setProgress(total ? Math.min(1, downloaded / total) : null));
    return () => void off.then((f) => f());
  }, [installing]);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await updater.install(); // relaunches on success
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "Update failed.");
      setInstalling(false);
      setProgress(null);
    }
  };

  const open = !!update && !dismissed;
  return (
    <AnimatePresence>
      {open && (
        <m.div
          initial={{ opacity: 0, y: -16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, transition: { duration: 0.18 } }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          className="glass-panel glass-strong fixed right-6 top-6 z-[85] w-[360px] rounded-[24px] p-5"
          role="dialog"
          aria-label="Update available"
        >
          <div className="flex items-start gap-3">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#0a84ff]" />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">Update Available</p>
              <p className="mt-0.5 text-[13px] leading-snug text-label-secondary">
                Omnia {update.version} is ready (you have {update.currentVersion}).
              </p>
              {update.notes && (
                <p className="mt-2 line-clamp-3 whitespace-pre-line text-[12px] leading-snug text-label-tertiary">{update.notes}</p>
              )}
              {error && <p className="mt-2 text-[12px] text-[#ff453a]">{error}</p>}
            </div>
            {!installing && (
              <button className="text-label-tertiary hover:text-label-primary" onClick={() => setDismissed(true)} aria-label="Dismiss">
                <CloseIcon size={16} />
              </button>
            )}
          </div>

          {installing && (
            <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full bg-[#0a84ff] transition-[width] duration-300 ${progress === null ? "w-1/3 animate-pulse" : ""}`}
                style={progress === null ? undefined : { width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            {!installing && (
              <button className="glass-button rounded-[12px] px-4 py-2 text-[13px]" onClick={() => setDismissed(true)}>
                Later
              </button>
            )}
            <button className="glass-button glass-button-primary rounded-[12px] px-4 py-2 text-[13px] font-semibold" onClick={install} disabled={installing}>
              {installing ? (progress === null ? "Downloading…" : `Installing… ${Math.round(progress * 100)}%`) : "Restart to Install"}
            </button>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
