/**
 * Boot shell: connects to the Rust backend, loads the active profile and settings, and renders
 * the Liquid Glass frame. The full catalog experience (sidebar, hero, rows, hubs, detail modal)
 * mounts inside this shell in Step 5.
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { isTauri, profiles, settings, SettingKeys, type AppProfile } from "./services/tauriBridge";

type BootState =
  | { status: "loading" }
  | { status: "ready"; profile: AppProfile; region: string | null }
  | { status: "error"; message: string };

export default function App() {
  const [boot, setBoot] = useState<BootState>({ status: "loading" });

  useEffect(() => {
    if (!isTauri()) {
      setBoot({ status: "error", message: "Omnia's backend is only available inside the desktop app." });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [all, list] = await Promise.all([settings.getAll(), profiles.list()]);
        const activeId = Number(all[SettingKeys.activeProfileId]);
        const profile = list.find((p) => p.profileId === activeId) ?? list[0];
        if (!profile) throw new Error("No local profile found.");
        if (!cancelled) {
          setBoot({ status: "ready", profile, region: all[SettingKeys.regionCode] ?? null });
        }
      } catch (err) {
        if (!cancelled) setBoot({ status: "error", message: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-[-20%] animate-ambient-drift opacity-70 blur-3xl"
        style={{
          background:
            "radial-gradient(40% 40% at 25% 30%, rgba(var(--ambient-1), 0.55), transparent 70%)," +
            "radial-gradient(35% 35% at 75% 65%, rgba(var(--ambient-2), 0.45), transparent 70%)," +
            "radial-gradient(30% 30% at 50% 90%, rgba(var(--ambient-3), 0.4), transparent 70%)",
        }}
      />
      <motion.section
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        className="glass-panel relative w-[420px] px-8 py-7"
      >
        <h1 className="text-3xl font-semibold tracking-tight">Omnia</h1>
        {boot.status === "loading" && <p className="mt-2 text-label-secondary">Opening your local library…</p>}
        {boot.status === "ready" && (
          <p className="mt-2 text-label-secondary">
            Signed in locally as <span className="text-label-primary">{boot.profile.profileName}</span>
            {boot.region ? ` · Region ${boot.region}` : " · Region not set"}
          </p>
        )}
        {boot.status === "error" && <p className="mt-2 text-red-300">{boot.message}</p>}
      </motion.section>
    </div>
  );
}
