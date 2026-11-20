"use client";
import { useTracker } from "@/components/tracker/TrackerProvider";

/** The signed-in account's synced picture, else its initial (guests: "G"). */
export function UserAvatar({ size = 40, className = "" }: { size?: number; className?: string }) {
  const t = useTracker();
  const url = t.profile?.avatarUrl;
  const name = t.profile?.displayName || t.user?.email || "Guest";
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-[#5e5ce6] to-[#0a84ff] font-bold shadow-specular ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {url ? <img src={url} alt="" width={size} height={size} className="h-full w-full object-cover" referrerPolicy="no-referrer" /> : (t.user ? name[0] : "G")!.toUpperCase()}
    </span>
  );
}

/** Display name for the account, falling back to the e-mail's local part. */
export const accountName = (t: ReturnType<typeof useTracker>) => t.profile?.displayName || t.user?.email?.split("@")[0] || "Signed in";
