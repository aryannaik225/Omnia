import { Suspense } from "react";
import { TrackerProvider } from "@/components/tracker/TrackerProvider";
import { currentUser } from "@/lib/session";
import { WebShell } from "@/omnia/components/layout/WebShell";

/**
 * The web app: the desktop app's UI (omnia/, ported from the repo's src/) in the browser, with
 * no login wall. Guests track in this browser; signing in (optional) syncs the library.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <TrackerProvider user={user}>
      <Suspense fallback={<div className="omnia-app" />}>
        <WebShell>{children}</WebShell>
      </Suspense>
    </TrackerProvider>
  );
}
