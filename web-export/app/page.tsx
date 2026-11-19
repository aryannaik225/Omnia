import { Credits } from "@/components/landing/Credits";
import { DesktopVsBrowser } from "@/components/landing/DesktopVsBrowser";
import { Dialogues } from "@/components/landing/Dialogues";
import { Download } from "@/components/landing/Download";
import { Features } from "@/components/landing/Features";
import { Fragmentation } from "@/components/landing/Fragmentation";
import { Handoff } from "@/components/landing/Handoff";
import { Hero } from "@/components/landing/hero/Hero";
import { Interface } from "@/components/landing/Interface";
import { Nav } from "@/components/landing/Nav";
import { OpenSource } from "@/components/landing/OpenSource";
import { Privacy } from "@/components/landing/Privacy";
import { SmartPlayer } from "@/components/landing/SmartPlayer";
import { TasteEngine } from "@/components/landing/TasteEngine";
import { TitleShowcase } from "@/components/landing/TitleShowcase";
import { getCatalog, getSpotlight, WALL } from "@/lib/landing";
import { getLatestRelease, RELEASES_URL, REPO_URL } from "@/lib/release";

// Static page, regenerated at most hourly: the GitHub release and TMDB art are fetched on the server.
export const revalidate = 3600;

export default async function Landing() {
  const [release, catalog, spotlight] = await Promise.all([getLatestRelease(), getCatalog(), getSpotlight()]);
  const posters = WALL.map((k) => catalog[k]);
  return (
    <div className="landing min-h-screen text-white">
      <div className="film-grain" aria-hidden />
      <Nav repoUrl={REPO_URL} />
      <main>
        <Hero posters={posters} version={release.version} />
        <Fragmentation />
        <Dialogues catalog={catalog} />
        <Interface />
        <Features catalog={catalog} />
        <SmartPlayer />
        <TitleShowcase spotlight={spotlight} />
        <TasteEngine />
        <Privacy />
        <Handoff catalog={catalog} />
        <DesktopVsBrowser version={release.version} />
        <Download
          version={release.version}
          tag={release.tag}
          publishedAt={release.publishedAt}
          pageUrl={release.pageUrl}
          releasesUrl={RELEASES_URL}
          exe={release.exe ? { ...release.exe, url: "/download/exe" } : null}
          msi={release.msi ? { ...release.msi, url: "/download/msi" } : null}
          setup={release.setup}
          notes={release.notes}
          live={release.live}
        />
        <OpenSource repoUrl={REPO_URL} />
      </main>
      <Credits repoUrl={REPO_URL} version={release.version} />
    </div>
  );
}
