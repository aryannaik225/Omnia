"use client";
import { AnimatePresence, m } from "framer-motion";
import { useAppStore } from "../../store/useAppStore";
import { CloseIcon } from "./Icons";

const DOT: Record<string, string> = {
  info: "bg-[#0a84ff]",
  success: "bg-[#30d158]",
  warning: "bg-[#ff9f0a]",
  error: "bg-[#ff453a]",
};

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[80] flex w-[360px] flex-col gap-3 max-md:inset-x-3 max-md:bottom-[calc(96px+env(safe-area-inset-bottom))] max-md:right-auto max-md:w-auto" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <m.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            className="glass-panel glass-strong pointer-events-auto flex items-start gap-3 rounded-[18px] px-4 py-3"
            role={t.kind === "error" ? "alert" : "status"}
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[t.kind]}`} />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold">{t.title}</p>
              {t.body && <p className="mt-0.5 text-[13px] leading-snug text-label-secondary">{t.body}</p>}
              {t.action && (
                <a href={t.action.href} className="glass-button-primary mt-2.5 !px-3.5 !py-1.5 !text-[13px]" onClick={() => dismiss(t.id)}>
                  {t.action.label}
                </a>
              )}
            </div>
            <button className="text-label-tertiary hover:text-label-primary" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <CloseIcon size={16} />
            </button>
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
