import { Hero, PosterRow, type RowItem } from "@/components/Rows";
import { Sidebar } from "@/components/Sidebar";
import { supabaseServer } from "@/lib/supabase/server";
import { popular, trending, type Title } from "@/lib/tmdb";

const fromTitles = (list: Title[]): RowItem[] =>
  list.filter((t) => t.posterPath).map((t) => ({ key: `${t.mediaType}-${t.id}`, title: t.title, posterPath: t.posterPath, subtitle: t.year ? String(t.year) : null }));

type ContinueRow = {
  tmdb_id: number;
  media_type: string;
  title: string | null;
  poster_path: string | null;
  season_number: number;
  episode_number: number;
  completion_ratio: number;
};
type CatalogRef = { title: string; poster_path: string | null };
type ListRow = { tmdb_id: number; media_type: string; media_catalog: CatalogRef | CatalogRef[] | null };

/** Home: hero, Continue Watching and Your List from Supabase (RLS: own rows only), TMDB rows. */
export const metadata = { title: "Home · Omnia" };

export default async function Home() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The user's first profile. A "Who's watching?" picker would choose one; this starter uses the first.
  const { data: profile } = await supabase.from("app_profiles").select("profile_id, profile_name").order("profile_id").limit(1).maybeSingle();
  const { data: region } = await supabase.from("user_settings").select("value").eq("key", "region_code").maybeSingle();
  const regionCode = region?.value ?? process.env.DEFAULT_REGION ?? "US";

  const [cw, list, trend, movies, series] = await Promise.all([
    profile
      ? supabase
          .from("continue_watching")
          .select("tmdb_id, media_type, title, poster_path, season_number, episode_number, completion_ratio, last_watched_at")
          .eq("profile_id", profile.profile_id)
          .order("last_watched_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),
    profile
      ? supabase
          .from("watchlist")
          .select("tmdb_id, media_type, added_at, media_catalog(title, poster_path)")
          .eq("profile_id", profile.profile_id)
          .order("added_at", { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [] }),
    trending().catch(() => [] as Title[]),
    popular("movie", regionCode).catch(() => [] as Title[]),
    popular("tv", regionCode).catch(() => [] as Title[]),
  ]);

  const continueItems: RowItem[] = ((cw.data ?? []) as ContinueRow[]).map((r) => ({
    key: `${r.media_type}-${r.tmdb_id}`,
    title: r.title ?? "Untitled",
    posterPath: r.poster_path,
    subtitle: r.media_type === "tv" && r.episode_number ? `S${r.season_number} E${r.episode_number}` : null,
    progress: r.completion_ratio,
  }));
  const listItems: RowItem[] = ((list.data ?? []) as unknown as ListRow[]).map((r) => {
    const c = Array.isArray(r.media_catalog) ? r.media_catalog[0] : r.media_catalog;
    return { key: `${r.media_type}-${r.tmdb_id}`, title: c?.title ?? "Untitled", posterPath: c?.poster_path ?? null };
  });

  const hero = trend.find((t) => t.backdropPath);
  return (
    <>
      <Sidebar email={user?.email ?? null} />
      <main className="pb-16">
        {hero && <Hero title={hero} />}
        <div className="relative z-10 -mt-12 flex flex-col gap-10 px-4 md:pl-[264px] md:pr-8">
          {profile && (
            <p className="text-[13px] text-label-tertiary">
              Watching as {profile.profile_name} · {regionCode}
            </p>
          )}
          <PosterRow title="Continue Watching" items={continueItems} />
          <PosterRow id="your-list" title="Your List" items={listItems} />
          <PosterRow title="Trending this week" items={fromTitles(trend)} />
          <PosterRow title="Popular movies" items={fromTitles(movies)} />
          <PosterRow title="Popular series" items={fromTitles(series)} />
        </div>
      </main>
    </>
  );
}
