/**
 * "Where do you want to watch this?" — shown when a title streams on more than one service and
 * the active profile hasn't picked one for it yet. The choice is remembered per profile + title
 * (SQLite `preferred_providers`), so the next Play routes straight to that OTT.
 */
import { AnimatePresence, m } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { MONETIZATION_LABEL } from "../../lib/format";
import { providerFamily } from "../../lib/providers";
import { isSubscribedLink, providerLogo, type LinkGroup } from "../../services/catalog";
import { useAppStore } from "../../store/useAppStore";
import { isStreamingLink, usePlayerStore } from "../../store/usePlayerStore";
import { CheckIcon, CloseIcon } from "../common/Icons";

function OptionButton({ group, logo, included, isCurrent, onPick, autoFocus }: {
  group: LinkGroup;
  logo: string | null;
  included: boolean;
  isCurrent: boolean;
  onPick: () => void;
  autoFocus: boolean;
}) {
  const l = group.primary;
  const detail = [
    included ? "Included with your subscription" : MONETIZATION_LABEL[l.monetizationType],
    l.quality,
    l.isFallback ? "Opens search" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <m.button
      type="button"
      autoFocus={autoFocus}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onPick}
      className={`glass-pill flex w-full items-center gap-3.5 py-2.5 pl-2.5 pr-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
        included ? "ring-1 ring-[#30d158]/60" : ""
      }`}
      title={l.isFallback ? `No direct link found; opens ${group.name} search` : undefined}
    >
      {logo ? (
        <img src={logo} alt="" className="h-11 w-11 shrink-0 rounded-[12px]" />
      ) : (
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-white/10 text-lg font-bold">{group.name[0]}</span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold">{group.name}</span>
        <span className={`block truncate text-[12px] ${included ? "text-[#30d158]" : "text-label-tertiary"}`}>{detail}</span>
      </span>
      {isCurrent && <span className="badge shrink-0">Current default</span>}
    </m.button>
  );
}

export function OttPickerModal() {
  const picker = usePlayerStore((s) => s.picker);
  const close = usePlayerStore((s) => s.closePicker);
  const playTitle = usePlayerStore((s) => s.playTitle);
  const subs = useAppStore((s) => s.subscriptions);
  const region = useAppStore((s) => s.region);
  const profile = useAppStore((s) => s.activeProfile);
  const [remember, setRemember] = useState(true);
  const openedFor = useRef<number | undefined>(undefined);

  // Reset per prompt; a profile switch invalidates an open prompt.
  useEffect(() => {
    if (picker) {
      setRemember(true);
      openedFor.current = profile?.profileId;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker]);
  useEffect(() => {
    if (picker && openedFor.current !== undefined && profile?.profileId !== openedFor.current) close();
  }, [picker, profile?.profileId, close]);

  // Esc closes only this prompt (capture phase, ahead of the detail modal's own Esc handler).
  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picker, close]);

  const d = picker?.details;
  const streaming = picker?.groups.filter((g) => isStreamingLink(g.primary)) ?? [];
  const other = picker?.groups.filter((g) => !isStreamingLink(g.primary)) ?? [];
  const currentKey = picker?.current ? providerFamily(picker.current.providerId, picker.current.providerName).key : null;

  const pick = (g: LinkGroup) => {
    if (!picker) return;
    close();
    void playTitle(picker.details, { ...picker.options, link: g.primary, remember, choose: false });
  };

  const section = (groups: LinkGroup[], offset: number) => (
    <div className="flex flex-col gap-2">
      {groups.map((g, i) => (
        <OptionButton
          key={g.key}
          group={g}
          logo={d ? providerLogo(d, region, g.primary) : null}
          included={isSubscribedLink(g.primary, subs) && isStreamingLink(g.primary)}
          isCurrent={g.key === currentKey}
          autoFocus={offset + i === 0}
          onPick={() => pick(g)}
        />
      ))}
    </div>
  );

  return (
    <AnimatePresence>
      {picker && d && (
        <m.div
          key="ott-picker"
          className="fixed inset-0 z-[60] flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ott-picker-title"
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={close} />
          <m.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className="glass-panel glass-strong relative flex max-h-[85vh] w-[min(460px,100%)] flex-col overflow-hidden p-6"
          >
            <button className="icon-button absolute right-4 top-4 !h-9 !w-9" onClick={close} aria-label="Cancel">
              <CloseIcon size={16} />
            </button>
            <p className="pr-10 text-[13px] font-semibold uppercase tracking-[0.1em] text-label-tertiary">{d.title}</p>
            <h2 id="ott-picker-title" className="mt-1 pr-10 text-[22px] font-bold tracking-tight">
              Where do you want to watch this?
            </h2>
            {picker.current && !picker.groups.some((g) => g.key === currentKey) && (
              <p className="mt-1.5 text-[13px] text-label-secondary">
                {picker.current.providerName} doesn't offer it in {region} anymore. Pick another service.
              </p>
            )}

            <div className="-mx-1 mt-5 flex flex-col gap-4 overflow-y-auto px-1 pb-1">
              {streaming.length > 0 && section(streaming, 0)}
              {other.length > 0 && (
                <div>
                  {streaming.length > 0 && <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-label-tertiary">Rent or buy</p>}
                  {section(other, streaming.length)}
                </div>
              )}
            </div>

            <label className="mt-5 flex cursor-pointer select-none items-center gap-2.5 text-[14px] text-label-secondary">
              <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="peer absolute inset-0 cursor-pointer opacity-0" />
                <span className="h-5 w-5 rounded-[6px] border border-white/30 bg-white/5 transition-colors peer-checked:border-[#0a84ff] peer-checked:bg-[#0a84ff] peer-focus-visible:ring-2 peer-focus-visible:ring-white/70" />
                {remember && <CheckIcon size={13} className="pointer-events-none absolute text-white" />}
              </span>
              Always open {d.title} here{profile ? ` for ${profile.profileName}` : ""}
            </label>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
