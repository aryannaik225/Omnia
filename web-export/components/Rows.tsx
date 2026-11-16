import Image from "next/image";
import { img, type Title } from "@/lib/tmdb";

export function Hero({ title }: { title: Title }) {
  const art = img(title.backdropPath, "w1280");
  return (
    <section className="relative h-[62vh] min-h-[420px] w-full overflow-hidden">
      {art && <Image src={art} alt="" fill priority sizes="100vw" className="object-cover" />}
      <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/40 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-ink-900/80 via-transparent to-transparent" />
      <div className="absolute bottom-[14%] left-4 right-4 max-w-[620px] md:left-[264px]">
        <h1 className="text-balance text-[34px] font-bold leading-tight tracking-tight drop-shadow-lg md:text-[56px]">{title.title}</h1>
        <p className="mt-3 line-clamp-3 text-[15px] text-white/80 md:text-[16px]">{title.overview}</p>
        <div className="mt-6 flex gap-3">
          <span className="glass-button-primary">▶ Play</span>
          <span className="glass-button">+ Up Next</span>
        </div>
      </div>
    </section>
  );
}

export interface RowItem {
  key: string;
  title: string;
  posterPath: string | null;
  subtitle?: string | null;
  progress?: number | null;
}

export function PosterRow({ id, title, items }: { id?: string; title: string; items: RowItem[] }) {
  if (!items.length) return null;
  return (
    <section id={id}>
      <h2 className="mb-3 text-[19px] font-semibold tracking-tight">{title}</h2>
      <div className="row-scroller">
        {items.map((it) => {
          const poster = img(it.posterPath);
          return (
            <div key={it.key} className="w-[140px] shrink-0 md:w-[168px]">
              <div className="poster aspect-[2/3] w-full">
                {poster ? (
                  <Image src={poster} alt={it.title} fill sizes="168px" className="object-cover" />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center p-3 text-center text-[13px]">{it.title}</span>
                )}
                {it.progress != null && (
                  <span className="absolute inset-x-2 bottom-2 h-[3px] overflow-hidden rounded-full bg-white/25">
                    <span className="block h-full bg-white" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                  </span>
                )}
              </div>
              <p className="mt-2 truncate text-[13px] font-medium">{it.title}</p>
              {it.subtitle && <p className="truncate text-[12px] text-label-tertiary">{it.subtitle}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
