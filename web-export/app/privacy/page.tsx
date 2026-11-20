import type { Metadata } from "next";
import Link from "next/link";
import { DataTable, LegalPage, Section } from "@/components/legal/LegalPage";
import { REPO_URL } from "@/lib/release";

export const metadata: Metadata = {
  title: "Privacy Policy · Omnia",
  description: "How Omnia handles your data: local-first on the desktop, optional and minimal cloud sync, and no analytics or ads.",
};

const UPDATED = "20 November 2026";
const a = "text-[#64d2ff] underline decoration-[#64d2ff]/40 underline-offset-2 hover:decoration-[#64d2ff]";

export default function PrivacyPolicy() {
  return (
    <LegalPage
      eyebrow="Privacy Policy"
      title="Your viewing stays yours."
      updated={UPDATED}
      intro={
        <>
          <p>
            Omnia is an open-source streaming hub: a desktop app for Windows (with an optional phone / TV companion on your home network) and a web app at{" "}
            <Link href="/app" className={a}>/app</Link>. This policy explains exactly what data each part handles, where it lives and how to delete it.
          </p>
          <p className="mt-3 text-white/60">
            In short: the desktop app keeps everything on your PC. Your streaming-service logins, cookies and on-device taste model never leave it. Cloud sync is optional, off until you
            sign in, and stores only your account details, an optional profile picture and a list of what you&apos;ve saved and watched. We don&apos;t use analytics, ads or trackers, and we
            never sell data.
          </p>
        </>
      }
    >
      <Section id="desktop" n={1} title="Omnia Desktop is local-first">
        <p>
          The desktop app stores its data in a SQLite database in your user profile&apos;s app-data folder on your PC. Nothing in it is uploaded unless you turn on cloud sync (section 3),
          and even then only the items listed there.
        </p>
        <DataTable
          rows={[
            ["Watch history & playback", "Progress, pauses, completed titles and episodes, and the time of day you watch, recorded by Omnia's player or imported from your services."],
            ["Taste model", "Recommendation vectors (embeddings) computed on your PC by a local AI model. Never uploaded."],
            ["Streaming-service sessions", "Your Netflix, Prime Video, JioHotstar and other sign-ins live in a separate, isolated browser profile per Omnia profile. Omnia's backend never reads or stores your cookies or passwords."],
            ["Profiles & settings", "Names, pictures, region, subscriptions, watchlist, favourites and collections."],
          ]}
        />
        <p>The desktop app only connects to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-white/90">The Movie Database (TMDB)</strong> for public catalog data (titles, artwork, cast). Requests contain what you browse or search for, never your
            history.
          </li>
          <li>
            <strong className="text-white/90">JustWatch</strong> to find a title&apos;s link on each service (title, year and region only).
          </li>
          <li>
            <strong className="text-white/90">Your streaming services</strong>, directly, inside the isolated player window, exactly as if you used their own website.
          </li>
          <li>
            <strong className="text-white/90">GitHub</strong> to check for and download signed updates, and <strong className="text-white/90">ipwho.is / ip-api.com</strong> to detect your
            country for regional availability (these services see your IP address, as any website does).
          </li>
          <li>
            <strong className="text-white/90">Supabase</strong>, only if you sign in to cloud sync (section 3).
          </li>
        </ul>
        <p>
          The optional phone / TV companion runs on your own local network. Paired devices talk only to your PC; Omnia stores a one-way hash of each device&apos;s pairing token, never the
          token itself.
        </p>
      </Section>

      <Section id="web" n={2} title="The web app">
        <p>
          You can use the web app as a guest: your library is saved in your browser&apos;s local storage and never sent to us. To show the catalog, your browser asks our server, which
          forwards the request to TMDB, so TMDB never sees your IP address and our API key stays private. We detect your country from your connection (our host&apos;s IP-country header, or an
          IP lookup) to show regional availability; we don&apos;t store it on our servers.
        </p>
        <p>
          The site is hosted on Vercel, which, like any web host, processes standard request logs (such as IP address, browser and requested page) to operate and secure the service. We
          don&apos;t add analytics or advertising scripts, and the only cookies we set are the sign-in session cookies used when you choose to sign in.
        </p>
      </Section>

      <Section id="cloud" n={3} title="Optional cloud sync (Supabase)">
        <p>
          If you sign in, on the web app or in the desktop app under Settings → Sign in to Sync, your library syncs between your devices through Supabase, our database and
          authentication provider. On the desktop, only the one Omnia profile you signed in with syncs. Exactly this is stored:
        </p>
        <DataTable
          rows={[
            ["Account", "Your email address and an account ID. With Google sign-in: the basic profile Google shares (your name, email address, profile-picture link and Google account ID). With email sign-in: a securely hashed password."],
            ["Profile", "A display name and, if you add one, a profile picture, shrunk on your device to a 256×256 image (about 30–50 KB) before upload. If you paste an image link instead, our server downloads that image once (without sending anything about you) so your browser can shrink it the same way. Pictures are stored at an unguessable link that anyone with the link can open, so only upload a picture you're happy to share."],
            ["Watchlist", "The TMDB ID and type of each title you save, and when you saved it."],
            ["Watched movies & episodes", "TMDB IDs, season and episode numbers, when you watched them and the runtime (used for your watch-time totals), plus timestamps that keep your devices in sync. For an episode your streaming service didn't number, its title is kept instead so it can be shown."],
          ]}
        />
        <p>
          <strong className="text-white/90">Never uploaded</strong>, even when signed in: your streaming-service logins, cookies and sessions; detailed playback telemetry (pauses, seeks,
          time-of-day patterns); your on-device taste model and embeddings; cached catalog metadata; and other Omnia profiles on your PC.
        </p>
        <p>
          Every row is protected by row-level security, so it can only be read or changed while signed in as you. Data is encrypted in transit (HTTPS) and at rest by Supabase.
        </p>
      </Section>

      <Section id="google" n={4} title="Google sign-in">
        <p>
          &ldquo;Continue with Google&rdquo; asks Google only for your basic profile and email address (the <code>openid</code>, <code>email</code> and <code>profile</code> scopes). We use them
          solely to create and sign in to your Omnia account, show your name and picture, and keep your library in sync. We don&apos;t access your Gmail, contacts, Drive, YouTube or any
          other Google data.
        </p>
        <p>
          Omnia&apos;s use and transfer of information received from Google APIs adheres to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer" className={a}>
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We don&apos;t sell this information, use it for advertising, or let people read it except where you ask us to (for support), for
          security, or where the law requires.
        </p>
      </Section>

      <Section id="sharing" n={5} title="Who we share data with">
        <p>
          No one, except the service providers that run Omnia on our behalf: Supabase (database, sign-in and picture storage) and Vercel (website hosting). They process data only to provide
          those services. We may disclose information if the law requires it. We never sell personal data or share it for advertising.
        </p>
      </Section>

      <Section id="choices" n={6} title="Your choices, retention and deletion">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-white/90">Desktop:</strong> delete history per title or per service, clear a profile&apos;s history, delete a profile (which also wipes its isolated
            browser data), or uninstall the app to remove everything. Signing out of cloud sync stops all uploads; your local data stays.
          </li>
          <li>
            <strong className="text-white/90">Web guest mode:</strong> clear your library in Settings, or clear your browser&apos;s site data.
          </li>
          <li>
            <strong className="text-white/90">Cloud account:</strong> in the web app, Settings → Account → <em>Delete account</em> permanently deletes your account, profile picture and every
            synced row immediately. Data otherwise stays until you delete it; &ldquo;Clear library&rdquo; marks your entries as removed so your other devices remove them too.
          </li>
          <li>
            You can export your library at any time (Settings → Export), and ask us to access, correct or delete your data through the contact link below.
          </li>
        </ul>
      </Section>

      <Section id="children" n={7} title="Children">
        <p>
          Omnia accounts are not intended for children under 13 (or the minimum age in your country). Kids profiles in the desktop app are local profiles a parent creates on their own PC and
          don&apos;t require an account.
        </p>
      </Section>

      <Section id="changes" n={8} title="Changes and contact">
        <p>
          We&apos;ll update this page when Omnia&apos;s data handling changes and revise the date above. Omnia is open source, so you can check every claim here against the code. Questions or
          requests:{" "}
          <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer" className={a}>
            open an issue on GitHub
          </a>{" "}
          (for anything private, ask there for a private contact and don&apos;t post personal details publicly).
        </p>
        <p>
          See also the <Link href="/terms" className={a}>Terms of Service</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
