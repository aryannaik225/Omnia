import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Section } from "@/components/legal/LegalPage";
import { REPO_URL } from "@/lib/release";

export const metadata: Metadata = {
  title: "Terms of Service · Omnia",
  description: "The terms for using Omnia Desktop, the Omnia web app and optional cloud sync.",
};

const UPDATED = "20 November 2026";
const a = "text-[#64d2ff] underline decoration-[#64d2ff]/40 underline-offset-2 hover:decoration-[#64d2ff]";

export default function Terms() {
  return (
    <LegalPage
      eyebrow="Terms of Service"
      title="The fine print, kept short."
      updated={UPDATED}
      intro={
        <p>
          These terms cover Omnia Desktop, the Omnia web app at <Link href="/app" className={a}>/app</Link> and optional cloud sync (together, &ldquo;Omnia&rdquo;). By using Omnia you agree to
          them. If you don&apos;t agree, please don&apos;t use it. How we handle data is described in the <Link href="/privacy" className={a}>Privacy Policy</Link>.
        </p>
      }
    >
      <Section id="what" n={1} title="What Omnia is">
        <p>
          Omnia helps you find where movies and series stream, keep track of what you watch, and open titles on the streaming services you already use. Omnia doesn&apos;t host, stream, sell or
          distribute any video. Playback always happens on the provider&apos;s own service, through your own subscription and account.
        </p>
      </Section>

      <Section id="license" n={2} title="Open-source license">
        <p>
          Omnia&apos;s source code is available under the{" "}
          <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className={a}>
            MIT License
          </a>
          , which governs your rights to use, copy, modify and distribute the software. These terms add the rules for using the services we operate (the website, the web app and cloud
          sync); if they conflict with the MIT License about the software itself, the license wins.
        </p>
      </Section>

      <Section id="services" n={3} title="Your streaming services">
        <p>
          You&apos;re responsible for following the terms of each streaming service you use with Omnia, including any limits on sharing accounts, regions or devices. Omnia is not affiliated
          with, endorsed by or sponsored by Netflix, Prime Video, Disney+, JioHotstar, Apple, Max or any other provider; their names and logos are trademarks of their owners and appear only to
          identify where titles are available. Availability and links come from TMDB and JustWatch and may be incomplete or out of date.
        </p>
      </Section>

      <Section id="accounts" n={4} title="Accounts and cloud sync">
        <ul className="list-disc space-y-2 pl-5">
          <li>An account is optional. You need one only to sync your library between devices.</li>
          <li>Give accurate sign-in details, keep your password safe, and tell us if you think your account has been misused.</li>
          <li>You must be at least 13 years old, or the minimum age in your country, to create an account.</li>
          <li>You can delete your account at any time from the web app (Settings → Account → Delete account).</li>
          <li>
            Cloud sync is provided free and as-is. We may change, limit or discontinue it; we&apos;ll try to give notice so you can export your library first. Your local desktop data is never
            affected.
          </li>
        </ul>
      </Section>

      <Section id="use" n={5} title="Acceptable use">
        <p>Don&apos;t use Omnia&apos;s services to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>break the law or infringe anyone&apos;s rights, including copyright;</li>
          <li>access another person&apos;s account or data, or try to get around security or rate limits;</li>
          <li>overload, scrape or disrupt the website, the TMDB proxy or the sync service;</li>
          <li>upload a profile picture that is unlawful, hateful, sexually explicit or that you don&apos;t have the right to use.</li>
        </ul>
        <p>We may suspend or delete accounts that break these rules.</p>
      </Section>

      <Section id="content" n={6} title="Your content and third-party data">
        <p>
          Your library and profile picture remain yours. You give us permission to store and process them only to run Omnia for you. Catalog data and artwork come from{" "}
          <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className={a}>
            TMDB
          </a>
          . This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability is provided by JustWatch.
        </p>
      </Section>

      <Section id="warranty" n={7} title="No warranty; limitation of liability">
        <p>
          Omnia is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without warranties of any kind, express or implied, including fitness for a particular purpose and
          non-infringement. We don&apos;t guarantee that Omnia will be uninterrupted, error-free or that synced data will never be lost, so keep exports of anything important.
        </p>
        <p>
          To the fullest extent the law allows, the Omnia contributors are not liable for any indirect, incidental, special or consequential damages, or for any loss of data, arising from your
          use of Omnia. Nothing in these terms limits rights you have under consumer law that can&apos;t be waived.
        </p>
      </Section>

      <Section id="changes" n={8} title="Changes and contact">
        <p>
          We may update these terms. We&apos;ll revise the date above, and for significant changes we&apos;ll give notice in the app or on this site. Continuing to use Omnia after a change means
          you accept the updated terms. Questions:{" "}
          <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer" className={a}>
            open an issue on GitHub
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
