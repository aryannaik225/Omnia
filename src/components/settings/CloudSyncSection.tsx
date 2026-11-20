/**
 * Settings → Sync (optional). Omnia is local-first with no login wall: until someone signs in
 * here, nothing is sent anywhere. Signed in, the active profile's watchlist, watched movies /
 * episodes (including what the OTT player and importer recorded) and its name + picture sync
 * two-way with Omnia Web. OTT sessions, playback telemetry, taste vectors and caches never leave
 * this PC. Rust holds the session; this component never sees a token.
 */
import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "../../lib/format";
import { cloud, OmniaEvents, type CloudStatus } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { Avatar, defaultAvatarFor, readAvatarFile } from "../common/Avatar";
import { RefreshIcon } from "../common/Icons";
import { listen } from "@tauri-apps/api/event";

type SectionProps = { title: string; description?: string; children: React.ReactNode };

/** "2026-11-20T10:00:00.000Z" → the SQLite-style UTC string `relativeTime` expects. */
const ago = (iso: string) => relativeTime(iso.slice(0, 19).replace("T", " "));

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function CloudSyncSection({ Section }: { Section: React.FC<SectionProps> }) {
  const profile = useAppStore((s) => s.activeProfile)!;
  const saveProfile = useAppStore((s) => s.saveProfile);
  const toast = useAppStore((s) => s.toast);
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "signin" | "signup" | "google" | "sync" | "signout" | "avatar">(null);

  const refresh = useCallback(() => cloud.status().then(setStatus).catch(() => undefined), []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    const off = listen(OmniaEvents.cloudSync, () => void refresh());
    return () => {
      clearInterval(t);
      void off.then((f) => f());
    };
  }, [refresh]);

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast({ kind: "error", title: "Sync", body: errText(e) });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  if (!status) return null;

  if (!status.configured) {
    return (
      <Section title="Sync (optional)" description="Omnia works fully offline. Cloud sync isn't set up in this build.">
        <p className="text-[13px] text-label-tertiary">
          To enable it, add <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> to <code>.env</code> and rebuild (see <code>supabase/schema.sql</code>).
        </p>
      </Section>
    );
  }

  if (!status.signedIn) {
    const signIn = () =>
      run("signin", async () => {
        const s = await cloud.signIn(email, password, profile.profileId);
        setStatus(s);
        setPassword("");
        toast({ kind: "success", title: "Signed in", body: `${profile.profileName} now syncs with ${s.email ?? "your account"}.` });
      });
    const signUp = () =>
      run("signup", async () => {
        const r = await cloud.signUp(email, password, profile.profileId);
        setStatus(r.status);
        setPassword("");
        toast(
          r.signedIn
            ? { kind: "success", title: "Account created", body: `${profile.profileName} now syncs.` }
            : { kind: "info", title: "Check your e-mail", body: "Confirm your address, then sign in here." },
        );
      });
    return (
      <Section
        title="Sign in to Sync (optional)"
        description="Keep your watchlist and watched movies & episodes in sync with Omnia Web on your phone or any browser. Until you sign in, nothing leaves this PC."
      >
        <div className="flex max-w-xl flex-col gap-3">
          <button className="glass-button justify-center" disabled={!!busy} onClick={() => void run("google", async () => {
            toast({ kind: "info", title: "Continue in your browser", body: "Finish signing in with Google, then come back here." });
            setStatus(await cloud.signInWithGoogle(profile.profileId));
            toast({ kind: "success", title: "Signed in with Google", body: `${profile.profileName} now syncs.` });
          })}>
            {busy === "google" ? "Waiting for Google…" : "Continue with Google"}
          </button>
          <div className="flex items-center gap-3 text-[12px] uppercase tracking-wider text-label-tertiary">
            <span className="h-px flex-1 bg-white/10" />
            or with e-mail
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <input className="glass-input" type="email" autoComplete="email" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            className="glass-input"
            type="password"
            autoComplete="current-password"
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && email && password.length >= 8 && void signIn()}
          />
          <div className="flex flex-wrap gap-3">
            <button className="glass-button-primary" disabled={!!busy || !email || password.length < 8} onClick={() => void signIn()}>
              {busy === "signin" ? "Signing in…" : "Sign in"}
            </button>
            <button className="glass-button" disabled={!!busy || !email || password.length < 8} onClick={() => void signUp()}>
              {busy === "signup" ? "Creating…" : "Create account"}
            </button>
          </div>
          <p className="text-[12px] leading-relaxed text-label-tertiary">
            Syncs the <span className="text-label-secondary">{profile.profileName}</span> profile only. Never uploaded: your OTT logins and cookies, playback telemetry,
            on-device taste vectors and cached metadata.
          </p>
        </div>
      </Section>
    );
  }

  const otherProfile = status.profileId !== null && status.profileId !== profile.profileId;
  const pickPhoto = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void run("avatar", async () => {
        const avatar = await readAvatarFile(file); // 256×256 WebP, ~30–50 KB
        await saveProfile({ profileId: profile.profileId, name: profile.profileName, isKids: profile.isKidsProfile, avatar });
        await cloud.syncNow();
        toast({ kind: "success", title: "Profile picture updated", body: "It syncs to Omnia Web and your other devices." });
      });
    };
    input.click();
  };

  return (
    <Section title="Sync" description="Two-way sync with Omnia Web. This PC's database stays the primary copy; changes on either side meet with the newest one winning.">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          {!otherProfile && (
            <button className="group relative shrink-0 rounded-full" onClick={pickPhoto} disabled={!!busy} aria-label="Change profile picture" title="Change profile picture">
              <Avatar name={profile.profileName} avatar={profile.avatarAsset ?? defaultAvatarFor(profile.profileId)} size={56} kids={profile.isKidsProfile} />
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-[11px] font-semibold opacity-0 transition-opacity group-hover:opacity-100">
                {busy === "avatar" ? "…" : "Change"}
              </span>
            </button>
          )}
          <div className="min-w-0">
            <p className="truncate text-[15px] font-medium">{status.email}</p>
            <p className="text-[13px] text-label-tertiary">
              Syncing profile <span className="text-label-secondary">{status.profileName ?? "—"}</span>
              {" · "}
              {status.lastSyncAt ? `last synced ${ago(status.lastSyncAt)}` : "first sync pending"}
              {status.pending > 0 && ` · ${status.pending} change${status.pending === 1 ? "" : "s"} to upload`}
            </p>
            {status.lastError && <p className="mt-1 text-[13px] text-[#ff6961]">{status.lastError}</p>}
            {otherProfile && <p className="mt-1 text-[13px] text-label-tertiary">You're on {profile.profileName}; only {status.profileName} syncs with this account.</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            className="glass-button"
            disabled={!!busy}
            onClick={() =>
              void run("sync", async () => {
                const r = await cloud.syncNow();
                toast({ kind: "success", title: "Synced", body: r ? `${r.pushed} uploaded · ${r.applied} received` : undefined });
              })
            }
          >
            <RefreshIcon size={15} /> {busy === "sync" ? "Syncing…" : "Sync now"}
          </button>
          <button
            className="glass-button"
            disabled={!!busy}
            onClick={() =>
              void run("signout", async () => {
                setStatus(await cloud.signOut());
                toast({ kind: "info", title: "Signed out", body: "Everything stays on this PC; syncing has stopped." });
              })
            }
          >
            Sign out
          </button>
        </div>
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-label-tertiary">
        Synced: watchlist, watched movies and episodes (with runtime), the profile's name and picture. Never uploaded: OTT logins and cookies, playback telemetry,
        taste vectors, cached metadata, other profiles.
      </p>
    </Section>
  );
}
