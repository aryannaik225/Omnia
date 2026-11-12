/**
 * Dominant-palette extraction for the ambient background bleed.
 * Runs entirely on-device on a tiny canvas (TMDB images are CORS-enabled).
 */

export type Rgb = [number, number, number];
export const DEFAULT_PALETTE: [Rgb, Rgb, Rgb] = [
  [40, 60, 120],
  [120, 40, 90],
  [20, 90, 110],
];

const paletteCache = new Map<string, Promise<[Rgb, Rgb, Rgb]>>();

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

/** Lifts very dark colours so the glow is visible but never glaring. */
function tune(c: Rgb): Rgb {
  const [, , l] = rgbToHsl(c);
  const factor = l < 0.25 ? 0.25 / Math.max(l, 0.05) : l > 0.65 ? 0.65 / l : 1;
  return c.map((v) => Math.max(0, Math.min(255, Math.round(v * Math.min(factor, 3))))) as Rgb;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image failed to load"));
    // Distinct URL so a cached non-CORS copy of the same artwork (from a plain <img>) is never
    // reused here; a tainted canvas would otherwise block pixel access.
    image.src = `${url}${url.includes("?") ? "&" : "?"}omnia-palette=1`;
  });
}

/**
 * Three dominant colours: pixels are quantised into 4-bit buckets, scored by frequency and
 * saturation (so a vivid accent beats a large grey area), then de-duplicated by hue.
 */
export async function extractPalette(url: string): Promise<[Rgb, Rgb, Rgb]> {
  const cached = paletteCache.get(url);
  if (cached) return cached;
  const job = (async () => {
    const image = await loadImage(url);
    const w = 48;
    const h = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return DEFAULT_PALETTE;
    ctx.drawImage(image, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.n += 1;
      buckets.set(key, bucket);
    }
    const scored = [...buckets.values()]
      .map((bk) => {
        const c: Rgb = [bk.r / bk.n, bk.g / bk.n, bk.b / bk.n];
        const [hue, s, l] = rgbToHsl(c);
        const lightPenalty = l < 0.08 || l > 0.92 ? 0.1 : 1;
        return { c, hue, score: bk.n * (0.35 + s) * lightPenalty };
      })
      .sort((a, b) => b.score - a.score);

    const picked: { c: Rgb; hue: number }[] = [];
    for (const s of scored) {
      if (picked.every((p) => Math.min(Math.abs(p.hue - s.hue), 360 - Math.abs(p.hue - s.hue)) > 28)) picked.push(s);
      if (picked.length === 3) break;
    }
    while (picked.length < 3) picked.push({ c: DEFAULT_PALETTE[picked.length]!, hue: 0 });
    return picked.map((p) => tune(p.c)) as [Rgb, Rgb, Rgb];
  })().catch(() => DEFAULT_PALETTE);
  paletteCache.set(url, job);
  return job;
}

export const rgbVar = (c: Rgb) => `${c[0]}, ${c[1]}, ${c[2]}`;
