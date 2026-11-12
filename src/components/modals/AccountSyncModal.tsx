/**
 * Connect Accounts: link each OTT profile to the active Omnia profile (the "Who's watching?"
 * handshake in the player window), import past history, or drop a CSV/JSON export.
 * Imports always land in the linked Omnia profile — never in another family member's.
 */
import { AnimatePresence, m } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { useAsync } from "../../lib/hooks";
import { img, regionProviders, type WatchProviderOption } from "../../services/tmdbClient";
import { ottMappings } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { usePlayerStore, type ImportState } from "../../store/usePlayerStore";
import { CheckIcon, CloseIcon, DownloadIcon, LinkIcon, TrashIcon, UploadIcon } from "../common/Icons";

/** Providers the handshake + history importer support (mirrors `OttProvider` in Rust; others import from file only). */
const SUPPORTED = /netflix|prime video|amazon|hotstar|jiocinema|zee5|sony ?liv|apple tv|disney|hbo|^max\b|hulu|peacock|paramount|crunchyroll/i;

function ImportProgress({ state }: { state: ImportState }) {
  if (state.stage === "error") return <p className="mt-2 text-[12px] text-[#ff6961]">{state.error}</p>;
  if (state.stage === "done") {
    const r = state.report;
    return (
      <p className="mt-2 text-[12px] text-[#30d158]">
        Imported {r?.imported ?? state.done} entries{r ? ` · ${r.matchedTitles} titles matched${r.unmatchedTitles.length ? ` · ${r.unmatchedTitles.length} unmatched` : ""}` : ""}
      </p>
    );
  }
  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : null;
  const label = { starting: "Starting…", fetching: "Reading history…", matching: "Matching titles…", saving: "Saving…" }[state.stage];
  return (
    <div className="mt-2">
      <p className="text-[12px] text-label-secondary">
        {label}
        {pct !== null ? ` ${pct}%` : ""}
      </p>
      <div className="progress-track mt-1.5">
        <div className={`progress-fill ${pct === null ? "animate-pulse" : ""}`} style={{ width: `${pct ?? 35}%` }} />
      </div>
    </div>
  );
}

export function AccountSyncModal() {
  const open = useAppStore((s) => s.accountSyncOpen);
  const setOpen = useAppStore((s) => s.setAccountSyncOpen);
  const profile = useAppStore((s) => s.activeProfile);
  const region = useAppStore((s) => s.region);
  const subs = useAppStore((s) => s.subscriptions);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const mappings = usePlayerStore((s) => s.mappings);
  const imports = usePlayerStore((s) => s.imports);
  const refreshMappings = usePlayerStore((s) => s.refreshMappings);
  const connect = usePlayerStore((s) => s.connect);
  const importFrom = usePlayerStore((s) => s.importFrom);
  const importFile = usePlayerStore((s) => s.importFile);
  const [dragging, setDragging] = useState(false);

  const regional = useAsync(() => regionProviders(region), [region], open && tmdbReady);
  useEffect(() => {
    if (open) void refreshMappings();
  }, [open, refreshMappings]);

  const providers = useMemo(() => {
    const map = new Map<number, WatchProviderOption>();
    for (const s of subs) map.set(s.providerId, { providerId: s.providerId, providerName: s.providerName, logoPath: s.logoPath, priority: -1 });
    for (const p of regional.data ?? []) if (SUPPORTED.test(p.providerName) && !map.has(p.providerId) && p.priority < 60) map.set(p.providerId, p);
    for (const mp of mappings)
      if (!map.has(mp.providerId)) map.set(mp.providerId, { providerId: mp.providerId, providerName: `Provider ${mp.providerId}`, logoPath: null, priority: 999 });
    return [...map.values()].filter((p) => SUPPORTED.test(p.providerName) || mappings.some((m) => m.providerId === p.providerId)).slice(0, 16);
  }, [subs, regional.data, mappings]);

  const onFiles = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) void importFile(f);
  };

  return (
    <AnimatePresence>
      {open && profile && (
        <m.div className="fixed inset-0 z-[60] flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/55 backdrop-blur-xl" onClick={() => setOpen(false)} />
          <m.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 280, damping: 30 }}
            className="glass-panel glass-strong relative max-h-[88vh] w-[min(860px,94vw)] overflow-y-auto p-8"
            role="dialog"
            aria-modal="true"
            aria-label="Connect accounts"
          >
            <button className="icon-button absolute right-5 top-5" onClick={() => setOpen(false)} aria-label="Close">
              <CloseIcon size={18} />
            </button>
            <h2 className="text-[28px] font-bold tracking-tight">Connect Accounts</h2>
            <p className="mt-1 max-w-[620px] text-label-secondary">
              Sign in inside Omnia's player and pick <em>your</em> profile. Omnia links it to <strong className="text-label-primary">{profile.profileName}</strong> and imports
              its history. Cookies never leave this device and are only sent to the service itself.
            </p>

            <ul className="mt-6 flex flex-col gap-2">
              {providers.map((p) => {
                const mapping = mappings.find((mp) => mp.providerId === p.providerId);
                const state = imports[`${profile.profileId}:${p.providerName}`];
                const busy = state && !["done", "error"].includes(state.stage);
                const logo = img(p.logoPath, "w92");
                return (
                  <li key={p.providerId} className="rounded-card bg-white/[0.04] px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
                    <div className="flex items-center gap-4">
                      {logo ? <img src={logo} alt="" className="h-11 w-11 rounded-[11px]" /> : <span className="flex h-11 w-11 items-center justify-center rounded-[11px] bg-white/10 font-bold">{p.providerName[0]}</span>}
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{p.providerName}</p>
                        <p className="text-[12px] text-label-tertiary">
                          {mapping ? (
                            <span className="inline-flex items-center gap-1 text-[#30d158]">
                              <CheckIcon size={13} /> Linked to {mapping.ottNativeProfileName ?? "profile"}
                            </span>
                          ) : (
                            "Not linked"
                          )}
                        </p>
                      </div>
                      <button className="glass-button !px-4 !py-2" onClick={() => void connect(p.providerId, p.providerName)}>
                        <LinkIcon size={15} /> {mapping ? "Re-link" : "Connect"}
                      </button>
                      {mapping && SUPPORTED.test(p.providerName) && (
                        <button className="glass-button !px-4 !py-2" disabled={busy} onClick={() => void importFrom(p.providerId, p.providerName)}>
                          <DownloadIcon size={15} /> {busy ? "Importing…" : "Import history"}
                        </button>
                      )}
                      {mapping && (
                        <button
                          className="icon-button !h-9 !w-9 text-label-tertiary hover:text-[#ff453a]"
                          aria-label={`Unlink ${p.providerName}`}
                          onClick={async () => {
                            await ottMappings.remove(profile.profileId, p.providerId);
                            await refreshMappings();
                          }}
                        >
                          <TrashIcon size={15} />
                        </button>
                      )}
                    </div>
                    {state && <ImportProgress state={state} />}
                  </li>
                );
              })}
              {!providers.length && <p className="text-label-secondary">{regional.loading ? "Loading services…" : "No supported services found for your region."}</p>}
            </ul>

            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                onFiles(e.dataTransfer.files);
              }}
              className={`mt-6 flex cursor-pointer flex-col items-center justify-center rounded-panel border border-dashed px-6 py-8 text-center transition-colors ${
                dragging ? "border-[#0a84ff] bg-[#0a84ff]/10" : "border-white/20 hover:bg-white/[0.04]"
              }`}
            >
              <UploadIcon size={26} className="text-label-secondary" />
              <p className="mt-2 font-semibold">Drop a history file</p>
              <p className="text-[13px] text-label-tertiary">Netflix “Download viewing activity” CSV, or an Omnia JSON export</p>
              <input type="file" accept=".csv,.json,text/csv,application/json" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
            </label>
            {Object.entries(imports)
              .filter(([k, v]) => k.startsWith(`${profile.profileId}:`) && /\.(csv|json)$/i.test(v.providerName))
              .map(([k, v]) => (
                <div key={k} className="mt-3 px-1">
                  <p className="text-[13px] font-medium">{v.providerName}</p>
                  <ImportProgress state={v} />
                </div>
              ))}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
