"use client";

import { AnimatePresence, motion, useInView } from "framer-motion";
import { Cpu, Move3d } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Heading, Lede, Reel } from "./ui";

type Bucket = "Morning" | "Afternoon" | "PrimeTime" | "LateNight";
const BUCKETS: Array<{ id: Bucket; label: string; hours: string }> = [
  { id: "Morning", label: "Morning", hours: "05–12" },
  { id: "Afternoon", label: "Afternoon", hours: "12–20" },
  { id: "PrimeTime", label: "Prime Time", hours: "20–23" },
  { id: "LateNight", label: "Late Night", hours: "23–04" },
];

type V3 = [number, number, number];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Three taste clusters found by spherical K-Means. Every title sits in the cluster of its genre:
 * a sci-fi film is never shown under sitcoms, and so on.
 */
const CLUSTERS: Array<{ name: string; short: string; color: string; dir: V3; titles: string[] }> = [
  { name: "Atmospheric sci-fi", short: "sci-fi", color: "#64d2ff", dir: norm([0.85, 0.35, 0.4]), titles: ["Arrival", "Dune", "Blade Runner 2049", "Interstellar", "Annihilation", "Ex Machina"] },
  { name: "Comfort sitcoms", short: "sitcom", color: "#ffd60a", dir: norm([-0.8, 0.45, 0.35]), titles: ["Brooklyn Nine-Nine", "The Office", "Parks and Recreation", "Schitt's Creek", "Abbott Elementary", "Ted Lasso"] },
  { name: "Slow-burn thrillers", short: "thriller", color: "#ff375f", dir: norm([0.05, -0.55, 0.85]), titles: ["Prisoners", "Mindhunter", "Zodiac", "Gone Girl", "Se7en", "True Detective"] },
];
const MIX: Record<Bucket, [number, number, number]> = {
  Morning: [0.25, 0.6, 0.15],
  Afternoon: [0.5, 0.3, 0.2],
  PrimeTime: [0.3, 0.15, 0.55],
  LateNight: [0.2, 0.55, 0.25],
};
const WHY: Record<Bucket, string> = {
  Morning: "Rediscover your Comfort Favorites, coffee optional",
  Afternoon: "Atmospheric sci-fi matching your weekend taste profile",
  PrimeTime: "Because you binged Mindhunter in three nights",
  LateNight: "Because you rewatch sitcoms late at night",
};

const BLOCKS = [
  { label: "Keywords", w: 0.4, color: "#bf5af2" },
  { label: "Director + top 3 cast", w: 0.25, color: "#64d2ff" },
  { label: "Genres", w: 0.2, color: "#30d158" },
  { label: "Plot (MiniLM, ONNX)", w: 0.15, color: "#ffd60a" },
];
const SIGNALS = [
  { label: "Love", v: 3.0 },
  { label: "Comfort rewatch", v: 2.0 },
  { label: "Binge velocity (3+ eps)", v: 1.8, mult: true },
  { label: "Completed > 85%", v: 1.0 },
  { label: "Abandoned at 10–25 min", v: -0.8 },
];

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
}

type Node = { v: V3; c: number; title?: string };

/** The point cloud: unlabelled catalog titles plus the named ones, all on the unit sphere. */
function buildCloud(): Node[] {
  const r = rng(11);
  const out: Node[] = [];
  CLUSTERS.forEach((cl, ci) => {
    for (let i = 0; i < 110; i++) {
      const sd = 0.2 + r() * 0.12;
      out.push({ v: norm([cl.dir[0] + gauss(r) * sd, cl.dir[1] + gauss(r) * sd, cl.dir[2] + gauss(r) * sd]), c: ci });
    }
    cl.titles.forEach((t) => out.push({ v: norm([cl.dir[0] + gauss(r) * 0.14, cl.dir[1] + gauss(r) * 0.14, cl.dir[2] + gauss(r) * 0.14]), c: ci, title: t }));
  });
  // background: the rest of the catalog, loosely spread
  for (let i = 0; i < 160; i++) out.push({ v: norm([gauss(r), gauss(r), gauss(r)]), c: -1 });
  return out;
}

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/**
 * A live projection of the embedding space: a slowly turning unit sphere (drag to orbit), the
 * three clusters as glowing point clouds, k-nearest-neighbour edges between named titles, and
 * your taste centroid for the chosen hour, with rays to the titles it would recommend.
 */
function EmbeddingSpace({ bucket, picks, onHover }: { bucket: Bucket; picks: string[]; onHover: (n: { title: string; c: number; sim: number } | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const inView = useInView(wrap);
  const cloud = useMemo(buildCloud, []);
  const named = useMemo(() => cloud.filter((n) => n.title), [cloud]);
  // three nearest neighbours of each named title, inside its cluster
  const edges = useMemo(() => {
    const e: Array<[Node, Node]> = [];
    named.forEach((a) => {
      named
        .filter((b) => b !== a && b.c === a.c)
        .sort((x, y) => dot(y.v, a.v) - dot(x.v, a.v))
        .slice(0, 2)
        .forEach((b) => e.push([a, b]));
    });
    return e;
  }, [named]);
  const target = useRef<V3>([0, 0, 1]);
  const state = useRef({ yaw: 0.6, pitch: 0.28, vyaw: 0, drag: false, lx: 0, ly: 0, centroid: [0, 0, 1] as V3, hover: null as Node | null, mx: -1, my: -1, idle: 0 });
  const picksRef = useRef(picks);
  picksRef.current = picks;

  useEffect(() => {
    const mix = MIX[bucket];
    target.current = norm([0, 1, 2].reduce<V3>((acc, i) => [acc[0] + CLUSTERS[i].dir[0] * mix[i], acc[1] + CLUSTERS[i].dir[1] * mix[i], acc[2] + CLUSTERS[i].dir[2] * mix[i]], [0, 0, 0]));
  }, [bucket]);

  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext("2d")!;
    let raf = 0;
    let last = performance.now();
    const s = state.current;
    // canvas can't resolve CSS variables: read the real font stacks next/font generated
    const css = getComputedStyle(document.documentElement);
    const sans = css.getPropertyValue("--font-grotesk").trim() || "system-ui, sans-serif";
    const mono = css.getPropertyValue("--font-mono").trim() || "monospace";
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.round(r.width * dpr);
      const H = Math.round(r.height * dpr);
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      // orbit: auto-rotate unless dragging, with inertia after a drag
      if (!s.drag) {
        s.idle += dt;
        s.vyaw += ((s.idle > 1.2 ? 0.12 : 0) - s.vyaw) * Math.min(1, dt * 1.5);
        s.yaw += s.vyaw * dt;
      }
      // centroid glides along the sphere to the new hour's taste
      s.centroid = norm([
        s.centroid[0] + (target.current[0] - s.centroid[0]) * Math.min(1, dt * 2.4),
        s.centroid[1] + (target.current[1] - s.centroid[1]) * Math.min(1, dt * 2.4),
        s.centroid[2] + (target.current[2] - s.centroid[2]) * Math.min(1, dt * 2.4),
      ]);

      const cy = Math.cos(s.yaw);
      const sy = Math.sin(s.yaw);
      const cp = Math.cos(s.pitch);
      const sp = Math.sin(s.pitch);
      const R = Math.min(W, H) * 0.36;
      const ox = W / 2;
      const oy = H / 2;
      const F = 3.2;
      const project = (v: V3) => {
        const x1 = v[0] * cy + v[2] * sy;
        const z1 = -v[0] * sy + v[2] * cy;
        const y2 = v[1] * cp - z1 * sp;
        const z2 = v[1] * sp + z1 * cp;
        const k = F / (F - z2);
        return { x: ox + x1 * R * k, y: oy - y2 * R * k, z: z2, k };
      };

      g.clearRect(0, 0, W, H);
      // sphere: soft body + latitude / longitude wireframe
      const body = g.createRadialGradient(ox - R * 0.3, oy - R * 0.35, R * 0.1, ox, oy, R * 1.15);
      body.addColorStop(0, "rgba(255,255,255,0.045)");
      body.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = body;
      g.beginPath();
      g.arc(ox, oy, R * 1.05, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 1 * dpr * 0.6;
      const ring = (pts: V3[]) => {
        for (let i = 1; i < pts.length; i++) {
          const a = project(pts[i - 1]);
          const b = project(pts[i]);
          const front = (a.z + b.z) / 2;
          g.strokeStyle = `rgba(255,255,255,${front > 0 ? 0.09 : 0.03})`;
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
        }
      };
      for (let lat = -60; lat <= 60; lat += 30) {
        const phi = (lat * Math.PI) / 180;
        ring(Array.from({ length: 73 }, (_, i) => [Math.cos(phi) * Math.cos((i / 72) * Math.PI * 2), Math.sin(phi), Math.cos(phi) * Math.sin((i / 72) * Math.PI * 2)] as V3));
      }
      for (let lon = 0; lon < 180; lon += 30) {
        const th = (lon * Math.PI) / 180;
        ring(Array.from({ length: 73 }, (_, i) => [Math.cos(th) * Math.cos((i / 72) * Math.PI * 2), Math.sin((i / 72) * Math.PI * 2), Math.sin(th) * Math.cos((i / 72) * Math.PI * 2)] as V3));
      }

      const mix = MIX[bucket];
      // cluster nebulae
      g.globalCompositeOperation = "lighter";
      CLUSTERS.forEach((cl, i) => {
        const p = project(cl.dir);
        const rad = R * (0.32 + mix[i] * 0.55) * p.k;
        const neb = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        neb.addColorStop(0, hexA(cl.color, (0.1 + mix[i] * 0.28) * (p.z > -0.2 ? 1 : 0.4)));
        neb.addColorStop(1, hexA(cl.color, 0));
        g.fillStyle = neb;
        g.fillRect(p.x - rad, p.y - rad, rad * 2, rad * 2);
      });
      g.globalCompositeOperation = "source-over";

      // points, back to front
      const proj = cloud.map((n) => ({ n, p: project(n.v) })).sort((a, b) => a.p.z - b.p.z);
      // k-NN edges
      g.lineWidth = dpr * 0.7;
      edges.forEach(([a, b]) => {
        const pa = project(a.v);
        const pb = project(b.v);
        const depth = (pa.z + pb.z) / 2;
        g.strokeStyle = hexA(CLUSTERS[a.c].color, depth > 0 ? 0.32 : 0.1);
        g.beginPath();
        g.moveTo(pa.x, pa.y);
        g.lineTo(pb.x, pb.y);
        g.stroke();
      });

      const cen = project(s.centroid);
      const ps = picksRef.current;
      // rays from the centroid to each recommended title
      g.setLineDash([3 * dpr, 4 * dpr]);
      g.lineDashOffset = -now / 40;
      g.lineWidth = dpr;
      proj.forEach(({ n, p }) => {
        if (!n.title || !ps.includes(n.title)) return;
        g.strokeStyle = hexA(CLUSTERS[n.c].color, p.z > 0 ? 0.75 : 0.3);
        g.beginPath();
        g.moveTo(cen.x, cen.y);
        g.lineTo(p.x, p.y);
        g.stroke();
      });
      g.setLineDash([]);

      // hover hit-test on named titles
      let hover: Node | null = null;
      let best = 18 * dpr;
      proj.forEach(({ n, p }) => {
        if (!n.title || s.mx < 0) return;
        const d = Math.hypot(p.x - s.mx * dpr, p.y - s.my * dpr);
        if (d < best) {
          best = d;
          hover = n;
        }
      });
      if (hover !== s.hover) {
        s.hover = hover;
        const h = hover as Node | null;
        onHover(h ? { title: h.title!, c: h.c, sim: dot(h.v, s.centroid) } : null);
      }

      g.textBaseline = "middle";
      const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
      proj.forEach(({ n, p }) => {
        const front = (p.z + 1) / 2; // 0 back … 1 front
        const col = n.c < 0 ? "#ffffff" : CLUSTERS[n.c].color;
        if (!n.title) {
          const a = n.c < 0 ? 0.08 + front * 0.12 : (0.15 + front * 0.55) * (0.5 + mix[n.c]);
          g.fillStyle = hexA(col, Math.min(1, a));
          g.beginPath();
          g.arc(p.x, p.y, (n.c < 0 ? 0.8 : 1.2) * dpr * p.k, 0, Math.PI * 2);
          g.fill();
          return;
        }
        const picked = ps.includes(n.title);
        const isHover = s.hover === n;
        const rad = (picked ? 3.6 : 2.6) * dpr * p.k * (isHover ? 1.4 : 1);
        g.globalCompositeOperation = "lighter";
        const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad * 4);
        halo.addColorStop(0, hexA(col, 0.35 * (0.3 + front)));
        halo.addColorStop(1, hexA(col, 0));
        g.fillStyle = halo;
        g.fillRect(p.x - rad * 4, p.y - rad * 4, rad * 8, rad * 8);
        g.globalCompositeOperation = "source-over";
        g.fillStyle = picked || isHover ? "#ffffff" : hexA(col, 0.4 + front * 0.6);
        g.beginPath();
        g.arc(p.x, p.y, rad, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = hexA(col, 0.9);
        g.lineWidth = dpr;
        g.stroke();
        if ((picked && p.z > -0.35) || isHover) {
          g.font = `${isHover ? 600 : 500} ${11 * dpr}px ${sans}`;
          const label = n.title;
          const tw = g.measureText(label).width;
          // nudge a label up or down (or to the left) until it clears the ones already drawn
          const tries: Array<[number, number]> = [[p.x + rad + 6 * dpr, p.y], [p.x + rad + 6 * dpr, p.y - 17 * dpr], [p.x + rad + 6 * dpr, p.y + 17 * dpr], [p.x - rad - 10 * dpr - tw, p.y]];
          const box = (x: number, y: number) => ({ x: x - 4 * dpr, y: y - 8 * dpr, w: tw + 8 * dpr, h: 16 * dpr });
          const hit = (b: { x: number; y: number; w: number; h: number }) => placed.some((o) => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h);
          const spot = tries.find(([x, y]) => !hit(box(x, y))) ?? (isHover ? tries[0] : null);
          if (spot) {
            const [lx, ly] = spot;
            const bb = box(lx, ly);
            placed.push(bb);
            g.fillStyle = "rgba(10,10,14,0.78)";
            g.beginPath();
            g.roundRect(bb.x, bb.y, bb.w, bb.h, 5 * dpr);
            g.fill();
            g.fillStyle = `rgba(255,255,255,${0.5 + front * 0.5})`;
            g.fillText(label, lx, ly + 0.5 * dpr);
          }
        }
      });

      // cluster labels
      g.font = `500 ${10 * dpr}px ${mono}`;
      CLUSTERS.forEach((cl, i) => {
        const p = project(cl.dir);
        if (p.z < -0.45) return;
        const txt = `${cl.name.toUpperCase()} · ${Math.round(mix[i] * 100)}%`;
        const tw = g.measureText(txt).width;
        g.fillStyle = hexA(cl.color, 0.55 + Math.max(0, p.z) * 0.45);
        g.fillText(txt, p.x - tw / 2, p.y - R * (0.3 + mix[i] * 0.3) * p.k);
      });

      // the taste centroid: a white star with a pulsing ring
      const pulse = (now / 1600) % 1;
      g.globalCompositeOperation = "lighter";
      const cg = g.createRadialGradient(cen.x, cen.y, 0, cen.x, cen.y, 26 * dpr);
      cg.addColorStop(0, "rgba(255,255,255,0.75)");
      cg.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = cg;
      g.fillRect(cen.x - 26 * dpr, cen.y - 26 * dpr, 52 * dpr, 52 * dpr);
      g.globalCompositeOperation = "source-over";
      g.strokeStyle = `rgba(255,255,255,${0.8 * (1 - pulse)})`;
      g.lineWidth = dpr;
      g.beginPath();
      g.arc(cen.x, cen.y, (5 + pulse * 16) * dpr, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = "#fff";
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const rr = (i % 2 ? 2 : 5.5) * dpr;
        g.lineTo(cen.x + Math.cos(a) * rr, cen.y + Math.sin(a) * rr);
      }
      g.fill();
      g.font = `600 ${10 * dpr}px ${mono}`;
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.fillText("YOU · " + BUCKETS.find((b) => b.id === bucket)!.label.toUpperCase(), cen.x + 10 * dpr, cen.y - 12 * dpr);

      raf = requestAnimationFrame(draw);
    };
    if (inView) raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [cloud, edges, bucket, inView, onHover]);

  return (
    <div ref={wrap} className="relative aspect-square w-full touch-pan-y sm:aspect-[4/3]">
      <canvas
        ref={ref}
        className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
        aria-label="A 3D projection of the taste embedding space with three clusters and your taste centroid"
        role="img"
        onPointerDown={(e) => {
          const s = state.current;
          s.drag = true;
          s.lx = e.clientX;
          s.ly = e.clientY;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const s = state.current;
          const r = (e.target as HTMLElement).getBoundingClientRect();
          s.mx = e.clientX - r.left;
          s.my = e.clientY - r.top;
          if (!s.drag) return;
          const dx = e.clientX - s.lx;
          const dy = e.clientY - s.ly;
          s.lx = e.clientX;
          s.ly = e.clientY;
          s.yaw += dx * 0.008;
          s.vyaw = dx * 0.5;
          s.pitch = Math.max(-1.1, Math.min(1.1, s.pitch + dy * 0.006));
          s.idle = 0;
        }}
        onPointerUp={() => (state.current.drag = false)}
        onPointerLeave={() => {
          state.current.mx = -1;
          state.current.drag = false;
        }}
      />
    </div>
  );
}

export function TasteEngine() {
  const [bucket, setBucket] = useState<Bucket>("PrimeTime");
  const [hover, setHover] = useState<{ title: string; c: number; sim: number } | null>(null);
  const mix = MIX[bucket];
  const top = mix.indexOf(Math.max(...mix));
  // Rows are filled in proportion to cluster weight (the lead cluster first), six titles in all.
  const picks = useMemo(() => {
    const order = [0, 1, 2].sort((a, b) => mix[b] - mix[a]);
    const quota = order.map((i) => Math.max(1, Math.round(mix[i] * 6)));
    while (quota.reduce((a, b) => a + b, 0) > 6) quota[quota.indexOf(Math.max(...quota))]--;
    return order.flatMap((ci, k) => CLUSTERS[ci].titles.slice(0, quota[k]).map((t) => ({ t, c: ci })));
  }, [mix]);
  const pickTitles = useMemo(() => picks.map((p) => p.t), [picks]);

  return (
    <section id="taste" className="relative overflow-hidden bg-black px-4 py-32 sm:px-8">
      <div className="pointer-events-none absolute right-0 top-20 h-[600px] w-[800px] rounded-full bg-[radial-gradient(circle,rgba(191,90,242,0.12),transparent_65%)]" />
      <div className="relative mx-auto max-w-[1180px]">
        <Reel n={6} label="The taste engine" />
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:items-end">
          <Heading>
            Taste, computed <span className="italic text-white/55">in the dark.</span>
          </Heading>
          <Lede>
            Every title becomes a vector on your machine with a quantized MiniLM model running in ONNX Runtime, in Rust. Spherical K-Means finds your taste clusters, MMR keeps the rows surprising, and your viewing hour decides which cluster leads.
          </Lede>
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="relative overflow-hidden rounded-[24px] p-5 lg-glass">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white/45">
                <Cpu size={13} /> on-device · 384-d, projected to 3
              </span>
              <div className="flex w-full rounded-[12px] bg-white/[0.07] p-1 text-[11px] font-semibold sm:w-auto sm:text-[12px]">
                {BUCKETS.map((b) => (
                  <button key={b.id} onClick={() => setBucket(b.id)} className="relative flex-1 whitespace-nowrap rounded-[9px] px-2 py-1.5 sm:flex-none sm:px-2.5" title={`${b.hours}h`}>
                    {bucket === b.id && <motion.span layoutId="bucket" className="absolute inset-0 rounded-[9px] bg-white/20" />}
                    <span className="relative">{b.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="relative mt-2">
              <EmbeddingSpace bucket={bucket} picks={pickTitles} onHover={setHover} />
              <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/30">
                <Move3d size={12} /> drag to orbit · hover a title
              </div>
              <AnimatePresence>
                {hover && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="pointer-events-none absolute right-2 top-2 rounded-[12px] px-3 py-2 lg-glass"
                  >
                    <p className="text-[13px] font-semibold text-white">{hover.title}</p>
                    <p className="font-mono text-[10px] uppercase tracking-[0.15em]" style={{ color: CLUSTERS[hover.c].color }}>
                      {CLUSTERS[hover.c].name}
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-white/60">cos(you, title) = {hover.sim.toFixed(2)}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence mode="wait">
              <motion.div key={bucket} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                <p className="font-display text-[21px] italic text-white">{WHY[bucket]}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {picks.map((p, i) => (
                    <motion.span
                      key={p.t}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1, transition: { delay: i * 0.05 } }}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium text-white lg-glass-soft"
                      style={{ boxShadow: `inset 0 0 0 1px ${CLUSTERS[p.c].color}55` }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: CLUSTERS[p.c].color }} />
                      {p.t}
                      <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-white/40">{CLUSTERS[p.c].short}</span>
                    </motion.span>
                  ))}
                </div>
                <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/30">Lead cluster: {CLUSTERS[top].name} · MMR λ keeps it varied</p>
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex flex-col gap-4">
            <div className="rounded-[24px] p-6 lg-glass">
              <p className="text-[13px] font-semibold text-white/80">What makes two titles similar</p>
              <p className="mt-1 font-mono text-[12px] text-white/45">sim = Σ wᵢ · cos(blockᵢ)</p>
              <div className="mt-4 space-y-3">
                {BLOCKS.map((b, i) => (
                  <div key={b.label}>
                    <div className="flex justify-between text-[13px]">
                      <span className="text-white/75">{b.label}</span>
                      <span className="font-mono text-white/50">{b.w.toFixed(2)}</span>
                    </div>
                    <div className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-white/10">
                      <motion.div initial={{ width: 0 }} whileInView={{ width: `${b.w * 250}%` }} viewport={{ once: true }} transition={{ duration: 1.2, delay: i * 0.1 }} className="h-full rounded-full" style={{ background: b.color }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-[24px] p-6 lg-glass">
              <p className="text-[13px] font-semibold text-white/80">How you watch teaches it</p>
              <div className="mt-4 space-y-2.5">
                {SIGNALS.map((s, i) => {
                  const neg = s.v < 0;
                  return (
                    <div key={s.label} className="grid grid-cols-[1fr_120px_44px] items-center gap-3 text-[13px]">
                      <span className="text-white/70">{s.label}</span>
                      <div className="relative h-[6px] rounded-full bg-white/10">
                        <span className="absolute left-[21%] top-[-3px] h-[12px] w-px bg-white/30" />
                        <motion.div
                          initial={{ width: 0 }}
                          whileInView={{ width: `${(Math.abs(s.v) / 3.8) * 100}%` }}
                          viewport={{ once: true }}
                          transition={{ duration: 1, delay: 0.2 + i * 0.1 }}
                          className={`absolute top-0 h-full rounded-full ${neg ? "right-[79%] bg-[#ff453a]" : "left-[21%] bg-[#30d158]"}`}
                        />
                      </div>
                      <span className={`text-right font-mono ${neg ? "text-[#ff453a]" : "text-[#30d158]"}`}>
                        {s.mult ? `×${s.v}` : `${neg ? "" : "+"}${s.v.toFixed(1)}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
