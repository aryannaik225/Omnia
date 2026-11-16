/** iPhone / browser playback: "Open in Netflix" as a real link (iOS Universal Links need a tap). */
import { AnimatePresence, m } from "framer-motion";
import { useHandoff } from "../../services/handoff";
import { PlayIcon } from "../common/Icons";

export function HandoffSheet() {
  const pending = useHandoff((s) => s.pending);
  const clear = useHandoff((s) => s.clear);
  return (
    <AnimatePresence>
      {pending && (
        <m.div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={clear} />
          <m.div
            role="dialog"
            aria-label={`Open in ${pending.providerName}`}
            initial={{ y: 40 }}
            animate={{ y: 0 }}
            exit={{ y: 40 }}
            transition={{ type: "spring", stiffness: 320, damping: 30 }}
            className="glass-panel glass-strong relative m-4 w-full max-w-[420px] px-6 pb-6 pt-5 text-center"
            style={{ paddingBottom: "max(24px, env(safe-area-inset-bottom))" }}
          >
            <p className="text-[13px] text-label-tertiary">Watch on {pending.providerName}</p>
            <h2 className="mt-1 truncate text-[20px] font-bold">{pending.title}</h2>
            <a href={pending.url} rel="noopener noreferrer" onClick={() => setTimeout(clear, 300)} className="glass-button-primary mt-5 flex w-full justify-center !py-3 text-[16px]">
              <PlayIcon size={16} /> Open in {pending.providerName}
            </a>
            <p className="mt-3 text-[12px] text-label-tertiary">
              {pending.isSearch ? "No direct link was found, so this opens the title's search." : `Opens the ${pending.providerName} app if it's installed, otherwise its website.`} Your progress syncs back to Omnia on your PC.
            </p>
            <button className="glass-button mt-4 w-full" onClick={clear}>
              Cancel
            </button>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
