"use client";
/**
 * Settings, web edition, laid out like the desktop's: account, region (auto-detected, with a
 * manual override for VPN / travel), the services you pay for, preferences, your data, and what
 * only the desktop app can do.
 */
import { AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTracker } from "@/components/tracker/TrackerProvider";
import { countItems, fromImport, toExport } from "@/lib/tracker";
import { flag, regionName } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { groupByFamily } from "../../lib/providers";
import { img, regionProviders } from "../../services/tmdbClient";
import type { SubscribedProvider } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { DesktopBadge } from "../common/DesktopOnly";
import { CheckIcon, DownloadIcon, GlobeIcon, RefreshIcon, TrashIcon, UploadIcon } from "../common/Icons";
import { RegionSwitcher } from "../layout/TopFilterBar";
import { UserAvatar, accountName } from "../common/UserAvatar";
import { PageHeader } from "./BrowseViews";

function Section({ id, title, subtitle, children }: { id?: string; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section id={id} className="glass-panel scroll-mt-28 px-7 py-6 max-md:px-5">
      <h2 className="section-title">{title}</h2>
      {subtitle && <p className="mt-1 text-[14px] text-label-secondary">{subtitle}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Toggle({ label, body, on, onChange }: { label: string; body: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0">
      <div>
        <p className="text-[15px] font-medium">{label}</p>
        <p className="text-[13px] text-label-tertiary">{body}</p>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" data-on={on} onClick={() => onChange(!on)} />
    </div>
  );
}

/** Desktop-only features: no dead buttons, just what they do and where to get them. */
const DESKTOP_ONLY = [
  { title: "Connect Netflix, Prime Video, JioHotstar & more", body: "Sign in once and Omnia imports your past viewing history, then keeps it in sync in the background." },
  { title: "Smart player with automatic tracking", body: "Play inside Omnia's native player: every pause, seek and episode skip is recorded to the second." },
  { title: "On-device recommendations", body: "“We Think You'll Love These” rows from a taste model that runs on your own PC." },
  { title: "Phone & TV pairing", body: "Browse from your phone or Android TV over your home Wi-Fi with a QR code and PIN." },
];

/** Signed in: picture (compressed to a 256x256 WebP on this device, synced everywhere), name, sign out. */
function AccountCard() {
  const t = useTracker();
  const toast = useAppStore((s) => s.toast);
  const pickRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const run = async (file: File | null) => {
    setBusy(true);
    try {
      await t.setAvatar(file);
      toast({ kind: "success", title: file ? "Profile picture updated" : "Profile picture removed", body: "It syncs to Omnia Desktop and your other browsers." });
    } catch (e) {
      toast({ kind: "error", title: "Couldn't update your picture", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      if (pickRef.current) pickRef.current.value = "";
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        <button type="button" className="group relative rounded-full" onClick={() => pickRef.current?.click()} disabled={busy} aria-label="Change profile picture">
          <UserAvatar size={64} />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-[11px] font-semibold opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            {busy ? "…" : "Change"}
          </span>
        </button>
        <div className="min-w-0">
          <p className="truncate text-[16px] font-semibold">{accountName(t)}</p>
          <p className="truncate text-[13px] text-label-tertiary">{t.user?.email}</p>
          <div className="mt-1.5 flex gap-3 text-[13px]">
            <button type="button" className="font-medium text-[#0a84ff] hover:underline disabled:opacity-50" onClick={() => pickRef.current?.click()} disabled={busy}>
              {t.profile?.avatarUrl ? "Change picture" : "Add a picture"}
            </button>
            {t.profile?.avatarUrl && (
              <button type="button" className="text-label-tertiary hover:text-label-primary disabled:opacity-50" onClick={() => void run(null)} disabled={busy}>
                Remove
              </button>
            )}
          </div>
        </div>
        <input ref={pickRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void run(e.target.files[0])} />
      </div>
      <div className="flex flex-wrap gap-3">
        <form action="/app/auth/signout" method="post">
          <button className="glass-button">Sign out</button>
        </form>
        <button
          type="button"
          className="glass-button !text-[#ff6961]"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm("Delete your Omnia account? Your profile, picture, watchlist and watched history are removed from the cloud for good. Omnia Desktop keeps its own local copy.")) return;
            setBusy(true);
            try {
              await t.deleteAccount();
              window.location.assign("/app");
            } catch (e) {
              toast({ kind: "error", title: "Couldn't delete your account", body: e instanceof Error ? e.message : String(e) });
              setBusy(false);
            }
          }}
        >
          Delete account
        </button>
      </div>
    </div>
  );
}

function Subscriptions() {
  const region = useAppStore((s) => s.region);
  const saved = useAppStore((s) => s.subscriptions);
  const save = useAppStore((s) => s.saveSubscriptions);
  const toast = useAppStore((s) => s.toast);
  const { data, loading, error } = useAsync(() => regionProviders(region), [region]);
  const families = useMemo(() => groupByFamily(data ?? [], (p) => p.providerId, (p) => p.providerName).slice(0, 40), [data]);
  const [showAll, setShowAll] = useState(false);
  const savedIds = new Set(saved.map((p) => p.providerId));
  const shown = showAll ? families : families.slice(0, 18);

  const toggle = (members: { providerId: number; providerName: string; logoPath: string | null }[]) => {
    const on = members.some((m) => savedIds.has(m.providerId));
    const ids = new Set(members.map((m) => m.providerId));
    const next: SubscribedProvider[] = on
      ? saved.filter((p) => !ids.has(p.providerId))
      : [...saved, ...members.map((m) => ({ providerId: m.providerId, providerName: m.providerName, logoPath: m.logoPath, regionCode: region, isActive: true }))];
    void save(next);
    if (!on) toast({ kind: "success", title: `${members[0]!.providerName} added`, body: "“My Subscriptions” now includes it." });
  };

  if (loading) return <div className="skeleton h-[120px] rounded-card" />;
  if (error) return <p className="text-label-secondary">{error}</p>;
  return (
    <div>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
        {shown.map(({ family, members }) => {
          const on = members.some((m) => savedIds.has(m.providerId));
          const logo = img(members.find((m) => m.logoPath)?.logoPath, "w92");
          return (
            <button
              key={family.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(members)}
              className={`flex items-center gap-3 rounded-pill px-2.5 py-2 text-left transition-colors ${on ? "bg-white/[0.14] shadow-specular" : "bg-white/[0.04] hover:bg-white/[0.08]"}`}
            >
              {logo ? <img src={logo} alt="" className="h-9 w-9 shrink-0 rounded-[9px]" /> : <span className="h-9 w-9 shrink-0 rounded-[9px] bg-white/10" />}
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{family.name}</span>
              {on && <CheckIcon size={16} className="shrink-0 text-[#30d158]" />}
            </button>
          );
        })}
      </div>
      {families.length > 18 && (
        <button className="chip mt-4" onClick={() => setShowAll((x) => !x)}>
          {showAll ? "Show fewer" : `Show all ${families.length} services`}
        </button>
      )}
    </div>
  );
}

export function SettingsView() {
  const t = useTracker();
  const region = useAppStore((s) => s.region);
  const source = useAppStore((s) => s.regionSource);
  const redetect = useAppStore((s) => s.redetectRegion);
  const subsOnly = useAppStore((s) => s.subscriptionsOnly);
  const setSubsOnly = useAppStore((s) => s.setSubscriptionsOnly);
  const subs = useAppStore((s) => s.subscriptions);
  const kids = useAppStore((s) => s.kidsSafeMode);
  const setKids = useAppStore((s) => s.setKidsSafeMode);
  const trailers = useAppStore((s) => s.trailerAutoplay);
  const setTrailers = useAppStore((s) => s.setTrailerAutoplay);
  const toast = useAppStore((s) => s.toast);
  const [regionOpen, setRegionOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!regionOpen) return;
    const onDown = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setRegionOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [regionOpen]);

  const total = countItems(t.data);
  const exportFile = () => {
    const blob = new Blob([JSON.stringify(toExport(t.data), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `omnia-library-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const incoming = fromImport(JSON.parse(await file.text()));
      const n = countItems(incoming);
      if (!n) throw new Error("No watched titles or watchlist entries in that file.");
      await t.replaceAll(incoming, "merge");
      toast({ kind: "success", title: `Imported ${n} item${n === 1 ? "" : "s"}`, body: file.name });
    } catch (e) {
      toast({ kind: "error", title: "Couldn't import that file", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const clear = async () => {
    if (!window.confirm(t.user ? "Delete your watchlist and everything you've marked as watched from your account?" : "Delete the library saved in this browser?")) return;
    setBusy(true);
    try {
      await t.clearAll();
      toast({ kind: "info", title: "Library cleared" });
    } catch (e) {
      toast({ kind: "error", title: "Couldn't clear your library", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-16">
      <PageHeader title="Settings" subtitle="Region, services, preferences and your library" />
      <div className="flex max-w-[920px] flex-col gap-6">
        <Section title="Account" subtitle={t.user ? "Your library syncs with Omnia Desktop and every browser you sign in on." : "Omnia works without an account: your library is saved in this browser."}>
          {t.user ? (
            <AccountCard />
          ) : t.canSignIn ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="max-w-[540px] text-[14px] text-label-secondary">Sign in to keep your library safe and use it on your other devices. Everything you've tracked in this browser comes with you.</p>
              <Link href="/app/login" className="glass-button-primary">
                Sign in to sync
              </Link>
            </div>
          ) : (
            <p className="text-[14px] text-label-secondary">Export a backup below to keep a copy or move it to another browser.</p>
          )}
        </Section>

        <Section id="region" title="Region" subtitle="Decides which services, availability and regional rows you see. Switch it when you're on a VPN or travelling.">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.08] text-[22px]">{flag(region) || <GlobeIcon size={20} />}</span>
              <div>
                <p className="text-[16px] font-semibold">
                  {regionName(region)} <span className="text-label-tertiary">({region})</span>
                </p>
                <p className="text-[13px] text-label-tertiary">{source === "auto" ? "Detected automatically from your location" : "Chosen manually"}</p>
              </div>
            </div>
            <div className="flex gap-2">
              {source === "manual" && (
                <button className="glass-button" onClick={() => void redetect().then((c) => toast({ kind: "success", title: "Region detected", body: `${regionName(c ?? region)} (${c ?? region})` }))}>
                  <RefreshIcon size={15} /> Detect automatically
                </button>
              )}
              <div ref={popRef} className="relative">
                <button className="glass-button" onClick={() => setRegionOpen((o) => !o)} aria-expanded={regionOpen}>
                  <GlobeIcon size={15} /> Change region
                </button>
                <AnimatePresence>{regionOpen && <RegionSwitcher onClose={() => setRegionOpen(false)} />}</AnimatePresence>
              </div>
            </div>
          </div>
        </Section>

        <Section id="subscriptions" title="My Subscriptions" subtitle={`The services you pay for in ${regionName(region)}. “My Subscriptions” in the top bar then shows only what you can stream on them.`}>
          <Toggle label="Show my subscriptions only" body={subs.length ? "Hides titles you'd have to rent, buy or watch elsewhere." : "Pick your services below first."} on={subsOnly} onChange={(v) => (subs.length || !v ? void setSubsOnly(v) : toast({ kind: "info", title: "Pick your services first" }))} />
          <div className="mt-5">
            <Subscriptions />
          </div>
        </Section>

        <Section title="Preferences">
          <div className="divide-y divide-white/[0.07]">
            <Toggle label="Kids & Family Safe Mode" body="Only family-friendly certifications and genres, everywhere in the catalog." on={kids} onChange={(v) => void setKids(v)} />
            <Toggle label="Trailer previews" body="Play a muted trailer after hovering the hero for two seconds." on={trailers} onChange={(v) => void setTrailers(v)} />
          </div>
        </Section>

        <Section title="Your Library" subtitle={`${total} tracked item${total === 1 ? "" : "s"} ${t.user ? "in your account" : "in this browser"}. Import accepts this app's export or the desktop app's “Export history” file.`}>
          <div className="flex flex-wrap gap-3">
            <button className="glass-button" onClick={exportFile} disabled={busy || t.status !== "ready"}>
              <DownloadIcon size={16} /> Export library
            </button>
            <button className="glass-button" onClick={() => fileRef.current?.click()} disabled={busy || t.status !== "ready"}>
              <UploadIcon size={16} /> Import…
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
            <button className="glass-button !text-[#ff6961]" onClick={() => void clear()} disabled={busy || t.status !== "ready" || !total}>
              <TrashIcon size={16} /> Clear library
            </button>
          </div>
        </Section>

        <Section title="More with Omnia Desktop" subtitle="The web app is a manual tracker. The desktop app does the tracking for you, and keeps all of it on your PC.">
          <ul className="flex flex-col divide-y divide-white/[0.07]">
            {DESKTOP_ONLY.map((f) => (
              <li key={f.title} className="flex flex-col gap-2 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <div>
                  <p className="text-[15px] font-medium">{f.title}</p>
                  <p className="text-[13px] text-label-tertiary">{f.body}</p>
                </div>
                <DesktopBadge />
              </li>
            ))}
          </ul>
        </Section>

        <p className="flex items-center gap-2 px-1 text-[12px] text-label-tertiary">
          <img src="/tmdb-logo.svg" alt="TMDB" className="h-[10px] w-auto" />
          Catalog data from TMDB, streaming availability from JustWatch. This product uses the TMDB API but is not endorsed or certified by TMDB.
        </p>
      </div>
    </div>
  );
}
