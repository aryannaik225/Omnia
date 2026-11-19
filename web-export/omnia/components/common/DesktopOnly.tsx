/**
 * The quiet "Available on Omnia Desktop" tag for features that need the desktop app (OTT account
 * sync, the smart player, on-device recommendations, phone / TV pairing). Links to the landing
 * page's download section.
 */
export const DESKTOP_DOWNLOAD_HREF = "/#download";

const Monitor = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);

export function DesktopBadge({ className = "" }: { className?: string }) {
  return (
    <a href={DESKTOP_DOWNLOAD_HREF} className={`chip !px-2.5 !py-1 !text-[11px] ${className}`} title="Get the Omnia desktop app">
      <Monitor />
      Available on Omnia Desktop
    </a>
  );
}

/** A line of context plus the badge. */
export function DesktopNote({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-label-tertiary ${className}`}>
      <span>{children}</span>
      <DesktopBadge />
    </div>
  );
}
