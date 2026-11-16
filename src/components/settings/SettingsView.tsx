/**
 * Settings: profile, region / VPN switcher, OTT subscriptions, account sync & history import,
 * recommendation engine status + explainable taste profile, privacy & playback.
 */
import { AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { flag, regionName } from "../../lib/format";
import { groupByFamily, providerFamily } from "../../lib/providers";
import { useAsync } from "../../lib/hooks";
import { envTmdbKey, img, regionProviders } from "../../services/tmdbClient";
import { BACKGROUND_SYNC_SETTING, recommendations, settings as settingsApi, type Affinity, type SubscribedProvider } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { Avatar, AvatarPicker, defaultAvatarFor } from "../common/Avatar";
import { CheckIcon, LinkIcon, RefreshIcon } from "../common/Icons";
import { RegionSwitcher } from "../layout/TopFilterBar";
import { PageHeader } from "../views/BrowseViews";
import { useDevMode } from "../../services/devMode";
import { isRemote, platformMode, setTvNavigation, tvNavigation } from "../../services/platform";
import { LinkedDevicesSection } from "./LinkedDevices";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="glass-panel min-w-0 max-w-full break-words px-7 py-6 max-md:px-4 max-md:py-5">
      <h2 className="text-[20px] font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-1 whitespace-normal text-[14px] text-label-secondary">{description}</p>}
      <div className="mt-5 min-w-0">{children}</div>
    </section>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2 max-md:gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">{label}</p>
        {hint && <p className="whitespace-normal break-words text-[13px] text-label-tertiary">{hint}</p>}
      </div>
      <button className="switch shrink-0" data-on={on} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />
    </div>
  );
}

function ProfileSection() {
  const profile = useAppStore((s) => s.activeProfile)!;
  const saveProfile = useAppStore((s) => s.saveProfile);
  const openGate = useAppStore((s) => s.openProfileGate);
  const toast = useAppStore((s) => s.toast);
  const [name, setName] = useState(profile.profileName);
  const [avatar, setAvatar] = useState(profile.avatarAsset ?? defaultAvatarFor(profile.profileId));
  const [kids, setKids] = useState(profile.isKidsProfile);
  useEffect(() => {
    setName(profile.profileName);
    setAvatar(profile.avatarAsset ?? defaultAvatarFor(profile.profileId));
    setKids(profile.isKidsProfile);
  }, [profile]);
  const dirty = name.trim() !== profile.profileName || avatar !== profile.avatarAsset || kids !== profile.isKidsProfile;

  return (
    <Section title="Profile" description="Each profile has its own history, watchlist, linked OTT profiles and recommendations.">
      <div className="flex items-start gap-6 max-md:flex-col max-md:gap-4">
        <Avatar name={name || "?"} avatar={avatar} size={88} kids={kids} />
        <div className="min-w-0 max-w-full flex-1">
          <input className="glass-input max-w-sm" value={name} onChange={(e) => setName(e.target.value)} aria-label="Profile name" />
          <div className="mt-4">
            <AvatarPicker value={avatar} onChange={setAvatar} />
          </div>
          <div className="max-w-sm">
            <Toggle on={kids} onChange={setKids} label="Kids profile" hint="Only family-safe titles, hubs and recommendations" />
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              className="glass-button-primary"
              disabled={!dirty || !name.trim()}
              onClick={async () => {
                await saveProfile({ profileId: profile.profileId, name: name.trim(), isKids: kids, avatar });
                toast({ kind: "success", title: "Profile updated" });
              }}
            >
              Save
            </button>
            <button className="glass-button" onClick={openGate}>
              Manage profiles
            </button>
          </div>
        </div>
      </div>
    </Section>
  );
}

function RegionSection() {
  const region = useAppStore((s) => s.region);
  const source = useAppStore((s) => s.regionSource);
  const redetect = useAppStore((s) => s.redetectRegion);
  const [open, setOpen] = useState(false);
  return (
    <Section title="Region & VPN" description="Catalog availability, providers and deep links follow this region. Switch it when you're travelling or on a VPN.">
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-4xl">{flag(region)}</span>
        <div className="min-w-0 flex-1 basis-[180px]">
          <p className="text-[17px] font-semibold">
            {regionName(region)} <span className="text-label-tertiary">({region})</span>
          </p>
          <p className="text-[13px] text-label-tertiary">{source === "auto" ? "Detected automatically from your connection" : "Set manually, so it won't be auto-detected"}</p>
        </div>
        <div className="relative">
          <button className="glass-button" onClick={() => setOpen((o) => !o)}>
            Change region
          </button>
          <AnimatePresence>{open && <RegionSwitcher onClose={() => setOpen(false)} />}</AnimatePresence>
        </div>
        <button className="glass-button" onClick={() => void redetect()}>
          <RefreshIcon size={15} /> Auto-detect
        </button>
      </div>
    </Section>
  );
}

function SubscriptionsSection() {
  const region = useAppStore((s) => s.region);
  const subs = useAppStore((s) => s.subscriptions);
  const save = useAppStore((s) => s.saveSubscriptions);
  const subscriptionsOnly = useAppStore((s) => s.subscriptionsOnly);
  const setSubscriptionsOnly = useAppStore((s) => s.setSubscriptionsOnly);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const toast = useAppStore((s) => s.toast);
  const options = useAsync(() => regionProviders(region), [region], tmdbReady);
  // Selection is per provider family ("Prime Video" covers its ad tier and the Amazon store).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const savedFamilies = useMemo(() => new Set(subs.map((s) => providerFamily(s.providerId, s.providerName).key)), [subs]);
  useEffect(() => setSelected(new Set(savedFamilies)), [savedFamilies]);

  const groups = useMemo(() => groupByFamily(options.data ?? [], (p) => p.providerId, (p) => p.providerName), [options.data]);
  const list = useMemo(() => groups.slice(0, showAll ? 200 : 30), [groups, showAll]);
  const dirty = selected.size !== savedFamilies.size || [...savedFamilies].some((k) => !selected.has(k));

  return (
    <Section title="My Subscriptions" description={`Services you pay for in ${regionName(region)}. Omnia highlights them everywhere and can hide everything else.`}>
      <Toggle
        on={subscriptionsOnly}
        onChange={(v) => void setSubscriptionsOnly(v)}
        label="My Subscriptions only"
        hint="Hide rent/buy titles and services you don't subscribe to"
      />
      <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(150px, 100%), 1fr))" }}>
        {options.loading && Array.from({ length: 12 }, (_, i) => <div key={i} className="skeleton h-[58px] rounded-pill" />)}
        {list.map(({ family, members }) => {
          const on = selected.has(family.key);
          const logo = img(members.find((m) => m.logoPath)?.logoPath, "w92");
          return (
            <button
              key={family.key}
              title={members.length > 1 ? `Includes ${members.map((m) => m.providerName).join(", ")}` : undefined}
              onClick={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(family.key)) next.delete(family.key);
                  else next.add(family.key);
                  return next;
                })
              }
              className={`flex items-center gap-3 rounded-pill p-2 text-left transition-colors ${on ? "bg-white/[0.16] shadow-specular" : "bg-white/[0.04] hover:bg-white/[0.08]"}`}
            >
              {logo && <img src={logo} alt="" className="h-10 w-10 rounded-[10px]" />}
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{family.name}</span>
              {on && <CheckIcon size={16} className="shrink-0 text-[#30d158]" />}
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="glass-button-primary"
          disabled={!dirty}
          onClick={async () => {
            // Every variant id is stored (so catalog filters match all of them) under one family name.
            const chosen: SubscribedProvider[] = groups
              .filter((g) => selected.has(g.family.key))
              .flatMap((g) => {
                const logo = g.members.find((m) => m.logoPath)?.logoPath ?? null;
                return g.members.map((m) => ({ providerId: m.providerId, providerName: g.family.name, logoPath: logo, regionCode: region, isActive: true }));
              });
            await save(chosen);
            toast({ kind: "success", title: "Subscriptions saved", body: `${selected.size} services in ${region}` });
          }}
        >
          Save subscriptions
        </button>
        {groups.length > 30 && (
          <button className="glass-button" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show fewer" : `Show all ${groups.length} services`}
          </button>
        )}
      </div>
    </Section>
  );
}

function AccountsSection() {
  const setOpen = useAppStore((s) => s.setAccountSyncOpen);
  const mappings = usePlayerStore((s) => s.mappings);
  const refreshMappings = usePlayerStore((s) => s.refreshMappings);
  useEffect(() => void refreshMappings(), [refreshMappings]);
  return (
    <Section title="Accounts & History" description="Link your OTT profiles to import past viewing and keep each family member's history separate.">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="min-w-0 flex-1 basis-[220px] text-[15px]">
          {mappings.length ? `${mappings.length} linked account${mappings.length > 1 ? "s" : ""}` : "No accounts linked yet"}
          <span className="block text-[13px] text-label-tertiary">You can also import a Netflix viewing-activity CSV or an Omnia backup.</span>
        </p>
        {isRemote ? (
          <span className="max-w-full text-[13px] text-label-tertiary md:max-w-[260px] md:text-right">Link accounts in Omnia on your PC: it signs in inside its own player window.</span>
        ) : (
          <button className="glass-button-primary" onClick={() => setOpen(true)}>
            <LinkIcon size={16} /> Connect accounts & import
          </button>
        )}
      </div>
    </Section>
  );
}

const SIGNAL_LABELS: [keyof Affinity, string][] = [
  ["completion", "Completed"],
  ["comfort", "Comfort favourite"],
  ["abandonment", "Abandoned"],
  ["skimming", "Skimmed"],
  ["watchlist", "Watchlisted"],
];

function RecommendationsSection() {
  const profile = useAppStore((s) => s.activeProfile);
  const loadRecs = useAppStore((s) => s.loadRecommendations);
  const recsLoading = useAppStore((s) => s.recsLoading);
  const [nonce, setNonce] = useState(0);
  const status = useAsync(() => recommendations.embeddingStatus(), [nonce, recsLoading]);
  const taste = useAsync(() => recommendations.tasteSummary(profile!.profileId, 12), [profile?.profileId, nonce], !!profile);
  const s = status.data;

  return (
    <Section title="Recommendations" description="Computed entirely on this device from your viewing behaviour. Nothing is uploaded.">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="min-w-0 flex-1 basis-[200px] text-[14px]">
          <span className="font-medium">Engine: </span>
          {!s ? "…" : !s.ready ? "Preparing on-device model…" : s.backend === "onnx" ? "MiniLM-L6 neural embeddings (ONNX, local)" : "Hashed text features (offline fallback)"}
        </p>
        <button
          className="glass-button"
          disabled={recsLoading}
          onClick={async () => {
            await loadRecs(true);
            setNonce((n) => n + 1);
          }}
        >
          <RefreshIcon size={15} /> {recsLoading ? "Refreshing…" : "Refresh picks"}
        </button>
      </div>

      {taste.data && taste.data.titles.length > 0 && (
        <>
          <h3 className="mb-2 mt-6 text-[15px] font-semibold">What shapes your taste</h3>
          <div className="divide-y divide-white/[0.06] rounded-card bg-white/[0.03]">
            {taste.data.titles.map((t) => (
              <div key={`${t.mediaType}-${t.tmdbId}`} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5">
                <span className="min-w-0 flex-1 basis-[140px] truncate text-[14px]">{t.title ?? `TMDB #${t.tmdbId}`}</span>
                <span className="flex flex-wrap justify-end gap-1.5">
                  {t.affinity.bingeMultiplier > 1 && <span className="chip !py-0.5 !text-[11px]">Binged ×{t.affinity.bingeMultiplier}</span>}
                  {SIGNAL_LABELS.filter(([k]) => t.affinity[k] !== 0).map(([k, label]) => (
                    <span key={k} className="chip !py-0.5 !text-[11px]">
                      {label}
                    </span>
                  ))}
                  {t.dominantBucket && <span className="chip !py-0.5 !text-[11px]">{t.dominantBucket}</span>}
                </span>
                <span className={`w-14 text-right font-mono text-[13px] ${t.affinity.weight >= 0 ? "text-[#30d158]" : "text-[#ff6961]"}`}>
                  {t.affinity.weight >= 0 ? "+" : ""}
                  {t.affinity.weight.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {taste.data.bucketWeights.map(([bucket, w]) => (
              <span key={bucket} className="chip">
                {bucket} · {Math.round(w * 100)}%
              </span>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

function BackgroundSyncToggle() {
  const toast = useAppStore((s) => s.toast);
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    settingsApi.get(BACKGROUND_SYNC_SETTING).then((v) => setOn(v !== "false")).catch(() => setOn(true));
  }, []);
  if (on === null) return null;
  return (
    <Toggle
      on={on}
      onChange={(v) => {
        setOn(v);
        settingsApi.set(BACKGROUND_SYNC_SETTING, String(v)).catch((e) => {
          setOn(!v);
          toast({ kind: "error", title: "Couldn't save the setting", body: String(e) });
        });
      }}
      label="Sync other devices in the background"
      hint="On startup and when Omnia comes back from the tray, linked accounts are quietly checked for new viewing (on your phone, TV…) in a hidden window. Only activity since the last sync is read."
    />
  );
}

function PrivacySection() {
  const trailerAutoplay = useAppStore((s) => s.trailerAutoplay);
  const setTrailerAutoplay = useAppStore((s) => s.setTrailerAutoplay);
  const kidsSafeMode = useAppStore((s) => s.kidsSafeMode);
  const setKidsSafeMode = useAppStore((s) => s.setKidsSafeMode);
  const tmdbReady = useAppStore((s) => s.tmdbReady);
  const setTmdbKey = useAppStore((s) => s.setTmdbKey);
  const [key, setKey] = useState("");

  return (
    <Section title="Privacy & Playback">
      <Toggle on={trailerAutoplay} onChange={(v) => void setTrailerAutoplay(v)} label="Trailer previews" hint="Muted trailers start after hovering the hero for 2 seconds (loaded from youtube-nocookie.com)" />
      <Toggle on={kidsSafeMode} onChange={(v) => void setKidsSafeMode(v)} label="Kids & Family Safe Mode" hint="Apply family-safe filtering to every profile on this device" />
      <BackgroundSyncToggle />
      {!isRemote && (
        <div className="mt-4 rounded-card bg-white/[0.04] px-4 py-3 text-[13px] text-label-secondary">
          <p className="font-medium text-label-primary">Back to Hub hotkeys</p>
          <p className="mt-1 leading-7">
            <kbd className="badge">Ctrl</kbd> + <kbd className="badge">Shift</kbd> + <kbd className="badge">O</kbd> or <kbd className="badge">Ctrl</kbd> + <kbd className="badge">Shift</kbd> +{" "}
            <kbd className="badge">H</kbd> saves your position, closes the player and returns here.
          </p>
        </div>
      )}
      <div className="mt-4">
        <p className="text-[15px] font-medium">TMDB API key</p>
        <p className="text-[13px] text-label-tertiary">
          {envTmdbKey ? "Loaded from TMDB_API_KEY in .env" : tmdbReady ? "Set in Omnia" : "Not configured — catalog browsing is unavailable"}
        </p>
        {!envTmdbKey && (
          <div className="mt-2 flex max-w-xl flex-wrap gap-3">
            <input className="glass-input" type="password" placeholder="v3 API key or v4 read token" value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="glass-button-primary" disabled={!key.trim()} onClick={() => void setTmdbKey(key).then(() => setKey(""))}>
              Save
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

/** Developer Options, shown once unlocked from the version number. */
function DeveloperSection() {
  const directStream = useDevMode((s) => s.directStream);
  const setDirectStream = useDevMode((s) => s.setDirectStream);
  const lock = useDevMode((s) => s.lock);
  const toast = useAppStore((s) => s.toast);
  return (
    <Section title="Developer Options" description="Hidden tools for testing. Nothing here is needed for normal use.">
      <Toggle
        on={directStream}
        onChange={(v) => void setDirectStream(v).catch((e) => toast({ kind: "error", title: "Couldn't save the setting", body: String(e) }))}
        label="Enable Direct Stream Testing"
        hint="Adds a “Stream (Dev)” button to movie and series pages that opens a plain HLS (.m3u8) / MP4 test player. Test streams aren't recorded in your history."
      />
      {platformMode !== "tv" && (
        <Toggle
          on={tvNavigation}
          onChange={(v) => setTvNavigation(v)}
          label="TV navigation on this device"
          hint="Arrow keys move a focus ring between cards like a TV remote (Enter selects, Esc goes back), with the on-screen keyboard. Reloads Omnia."
        />
      )}
      <button className="glass-button mt-3 !py-2 text-[13px]" onClick={() => void lock()}>
        Hide Developer Options
      </button>
    </Section>
  );
}

const TAPS_TO_UNLOCK = 7;

/** The version number; tapping it 7 times in a row unlocks Developer Options. */
function VersionFooter() {
  const unlocked = useDevMode((s) => s.unlocked);
  const unlock = useDevMode((s) => s.unlock);
  const toast = useAppStore((s) => s.toast);
  const [taps, setTaps] = useState(0);
  const [lastTap, setLastTap] = useState(0);
  const onTap = () => {
    if (unlocked) {
      toast({ kind: "info", title: "Developer Options are already on" });
      return;
    }
    const now = Date.now();
    // Taps more than 2 s apart start over.
    const n = now - lastTap > 2000 ? 1 : taps + 1;
    setTaps(n);
    setLastTap(now);
    if (n >= TAPS_TO_UNLOCK) {
      setTaps(0);
      void unlock().then(() => toast({ kind: "success", title: "Developer Options unlocked" }));
    } else if (n >= 4) {
      toast({ kind: "info", title: `${TAPS_TO_UNLOCK - n} more tap${TAPS_TO_UNLOCK - n > 1 ? "s" : ""}…` });
    }
  };
  const where = platformMode === "desktop" ? "Desktop" : platformMode === "tv" ? "Android TV client" : "Web companion";
  return (
    <div className="py-4 text-center text-[13px] text-label-tertiary">
      <button className="rounded-pill px-3 py-1 hover:text-label-secondary" onClick={onTap} aria-label={`Omnia version ${__APP_VERSION__}`}>
        Omnia {__APP_VERSION__} · {where}
      </button>
    </div>
  );
}

export function SettingsView() {
  const devUnlocked = useDevMode((s) => s.unlocked);
  const loadDev = useDevMode((s) => s.load);
  useEffect(() => void loadDev(), [loadDev]);
  return (
    <div className="flex w-full min-w-0 max-w-[980px] flex-col gap-6 pb-16">
      <PageHeader title="Settings" subtitle={isRemote ? "Your data stays on your PC; this device reads it over your Wi-Fi." : "Everything stays on this device."} />
      <ProfileSection />
      <RegionSection />
      <SubscriptionsSection />
      <AccountsSection />
      {platformMode === "desktop" && <LinkedDevicesSection Section={Section} Toggle={Toggle} />}
      <RecommendationsSection />
      <PrivacySection />
      {devUnlocked && <DeveloperSection />}
      <VersionFooter />
    </div>
  );
}
