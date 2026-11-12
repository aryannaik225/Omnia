/** "Who's watching?" — chooses the active `app_profile_id`; add / edit / delete profiles. */
import { AnimatePresence, m } from "framer-motion";
import { useState } from "react";
import type { AppProfile } from "../../services/tauriBridge";
import { useAppStore } from "../../store/useAppStore";
import { Avatar, AVATAR_PALETTES, avatarKeys, defaultAvatarFor } from "../common/Avatar";
import { PencilIcon, PlusIcon, TrashIcon } from "../common/Icons";

function ProfileEditor({ profile, onClose }: { profile: AppProfile | null; onClose: () => void }) {
  const saveProfile = useAppStore((s) => s.saveProfile);
  const deleteProfile = useAppStore((s) => s.deleteProfile);
  const profilesCount = useAppStore((s) => s.profiles.length);
  const [name, setName] = useState(profile?.profileName ?? "");
  const [kids, setKids] = useState(profile?.isKidsProfile ?? false);
  const [avatar, setAvatar] = useState(profile?.avatarAsset ?? defaultAvatarFor(profilesCount + 1));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await saveProfile({ profileId: profile?.profileId, name: name.trim(), isKids: kids, avatar });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <m.div className="fixed inset-0 z-[70] flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-xl" onClick={onClose} />
      <m.form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        initial={{ scale: 0.96, y: 16 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 16 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        className="glass-panel glass-strong relative w-[440px] p-8 text-center"
      >
        <h2 className="text-[24px] font-bold">{profile ? "Edit profile" : "Add profile"}</h2>
        <div className="my-6 flex justify-center">
          <Avatar name={name || "?"} avatar={avatar} size={112} kids={kids} />
        </div>
        <input autoFocus className="glass-input text-center text-[16px]" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
        <div className="mt-4 flex justify-center gap-2.5">
          {avatarKeys.map((k) => {
            const [a, b] = AVATAR_PALETTES[k]!;
            return (
              <button
                type="button"
                key={k}
                aria-label={`Avatar ${k}`}
                onClick={() => setAvatar(k)}
                className={`h-8 w-8 rounded-full transition-transform hover:scale-110 ${avatar === k ? "ring-2 ring-white" : ""}`}
                style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}
              />
            );
          })}
        </div>
        <label className="mt-6 flex items-center justify-between rounded-pill bg-white/[0.05] px-4 py-3 text-left">
          <span>
            <span className="block text-[15px] font-medium">Kids profile</span>
            <span className="block text-[12px] text-label-tertiary">Family-safe titles only</span>
          </span>
          <button type="button" className="switch" data-on={kids} role="switch" aria-checked={kids} onClick={() => setKids((k) => !k)} />
        </label>
        <div className="mt-7 flex justify-center gap-3">
          {profile && profilesCount > 1 && (
            <button
              type="button"
              className="glass-button !text-[#ff6961]"
              onClick={async () => {
                if (await deleteProfile(profile.profileId)) onClose();
              }}
            >
              <TrashIcon size={16} /> Delete
            </button>
          )}
          <button type="button" className="glass-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="glass-button-primary" disabled={!name.trim() || busy}>
            Save
          </button>
        </div>
        {profile && <p className="mt-4 text-[12px] text-label-tertiary">Deleting a profile removes its history, watchlist, linked accounts and taste data.</p>}
      </m.form>
    </m.div>
  );
}

export function ProfileGate() {
  const profiles = useAppStore((s) => s.profiles);
  const selectProfile = useAppStore((s) => s.selectProfile);
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<AppProfile | null | "new">(null);

  return (
    <div className="fixed inset-0 z-[65] flex flex-col items-center justify-center">
      <m.h1
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 200, damping: 24 }}
        className="text-[44px] font-bold tracking-tight"
      >
        {managing ? "Manage profiles" : "Who's watching?"}
      </m.h1>
      <div className="mt-12 flex flex-wrap justify-center gap-10">
        {profiles.map((p, i) => (
          <m.button
            key={p.profileId}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 * i, type: "spring", stiffness: 260, damping: 24 }}
            whileHover={{ scale: 1.08 }}
            whileFocus={{ scale: 1.08 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => (managing ? setEditing(p) : void selectProfile(p))}
            className="group flex w-[150px] flex-col items-center gap-4 outline-none"
          >
            <span className="relative">
              <Avatar name={p.profileName} avatar={p.avatarAsset ?? defaultAvatarFor(p.profileId)} size={140} kids={p.isKidsProfile} />
              {managing && (
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45">
                  <PencilIcon size={30} />
                </span>
              )}
              <span className="pointer-events-none absolute -inset-1.5 rounded-full opacity-0 ring-[3px] ring-white transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </span>
            <span className="text-[17px] font-medium text-label-secondary group-hover:text-label-primary">{p.profileName}</span>
          </m.button>
        ))}
        <m.button
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 * profiles.length, type: "spring", stiffness: 260, damping: 24 }}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.97 }}
          onClick={() => setEditing("new")}
          className="flex w-[150px] flex-col items-center gap-4"
        >
          <span className="glass flex h-[140px] w-[140px] items-center justify-center rounded-full">
            <PlusIcon size={44} />
          </span>
          <span className="text-[17px] font-medium text-label-secondary">Add Profile</span>
        </m.button>
      </div>
      <button className="glass-button mt-14" onClick={() => setManaging((v) => !v)}>
        {managing ? "Done" : "Manage profiles"}
      </button>
      <AnimatePresence>{editing && <ProfileEditor profile={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}</AnimatePresence>
    </div>
  );
}
