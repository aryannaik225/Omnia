/**
 * Four short "films" for the Smart Player demo, painted procedurally on a 2D canvas: layered
 * parallax, volumetric light, particles, colour grading, grain and a vignette. Each scene is a
 * pure function of time, so pausing simply stops the clock and thumbnails are a single frame.
 */

export type SceneId = 0 | 1 | 2 | 3;
type G = CanvasRenderingContext2D;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Smooth 1-D value noise in [-1, 1]. */
function noise1(x: number, seed = 0) {
  const h = (n: number) => {
    const v = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
    return v - Math.floor(v);
  };
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (h(i) * (1 - u) + h(i + 1) * u) * 2 - 1;
}
const fbm = (x: number, seed = 0) => noise1(x, seed) * 0.6 + noise1(x * 2.1, seed + 1) * 0.28 + noise1(x * 4.3, seed + 2) * 0.12;

function glow(g: G, x: number, y: number, r: number, color: string, alpha = 1) {
  const grd = g.createRadialGradient(x, y, 0, x, y, r);
  grd.addColorStop(0, color);
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.globalAlpha = alpha;
  g.fillStyle = grd;
  g.fillRect(x - r, y - r, r * 2, r * 2);
  g.globalAlpha = 1;
}

function vgrad(g: G, y0: number, y1: number, stops: Array<[number, string]>) {
  const grd = g.createLinearGradient(0, y0, 0, y1);
  stops.forEach(([o, c]) => grd.addColorStop(o, c));
  return grd;
}

/** A ridge line across the frame from layered noise, filled down to the bottom. */
function ridge(g: G, w: number, h: number, base: number, amp: number, freq: number, shift: number, seed: number, fill: string | CanvasGradient, sharp = 0) {
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w + 8; x += 8) {
    const n = fbm((x / w) * freq + shift, seed);
    const y = base - (sharp ? Math.abs(n) * amp * 1.6 - amp * 0.3 : n * amp);
    g.lineTo(x, y);
  }
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

/* ───────────── 1 · Dunes at dusk ───────────── */

const sand = (() => {
  const r = rng(11);
  return Array.from({ length: 140 }, () => ({ x: r(), y: 0.45 + r() * 0.55, s: 0.3 + r() * 1.2, v: 0.02 + r() * 0.05, o: r() }));
})();

function dunes(g: G, w: number, h: number, t: number) {
  g.fillStyle = vgrad(g, 0, h * 0.62, [
    [0, "#0b1424"],
    [0.45, "#3a2140"],
    [0.78, "#b4532a"],
    [1, "#f3a54a"],
  ]);
  g.fillRect(0, 0, w, h);
  // the sun, low and heavy, slightly squashed by the atmosphere
  const sx = w * 0.64;
  const sy = h * 0.54 + Math.sin(t * 0.05) * 2;
  g.globalCompositeOperation = "lighter";
  glow(g, sx, sy, h * 0.9, "rgba(255,150,60,0.35)");
  glow(g, sx, sy, h * 0.25, "rgba(255,200,120,0.55)");
  g.globalCompositeOperation = "source-over";
  g.fillStyle = "#ffe2a8";
  g.beginPath();
  g.ellipse(sx, sy, h * 0.085, h * 0.078, 0, 0, Math.PI * 2);
  g.fill();
  // heat haze bands over the sun
  g.globalAlpha = 0.06;
  for (let i = 0; i < 5; i++) {
    const y = sy - h * 0.03 + i * h * 0.018;
    g.fillStyle = "#c86a33";
    g.fillRect(sx - h * 0.12 + Math.sin(t * 1.5 + i) * 3, y, h * 0.24, 1.5);
  }
  g.globalAlpha = 1;

  // dune layers: far → near, drifting at different speeds (the camera trucks right)
  const layers = [
    { base: 0.62, amp: 0.035, f: 2.2, sp: 0.004, c0: "#a5502f", c1: "#7a3424" },
    { base: 0.68, amp: 0.05, f: 1.7, sp: 0.008, c0: "#7c3520", c1: "#4a1d16" },
    { base: 0.76, amp: 0.06, f: 1.3, sp: 0.014, c0: "#4f1f15", c1: "#26100c" },
    { base: 0.88, amp: 0.07, f: 1.0, sp: 0.024, c0: "#21100b", c1: "#0a0504" },
  ];
  layers.forEach((L, i) => {
    const shift = t * L.sp;
    ridge(g, w, h, h * L.base, h * L.amp, L.f, shift, 3 + i, vgrad(g, h * (L.base - L.amp), h, [[0, L.c0], [1, L.c1]]));
    // sunlit crest
    g.beginPath();
    for (let x = 0; x <= w + 8; x += 8) {
      const y = h * L.base - fbm((x / w) * L.f + shift, 3 + i) * h * L.amp;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = `rgba(255,190,120,${0.35 - i * 0.07})`;
    g.lineWidth = 1.2;
    g.stroke();
  });

  // a lone walker on the second-nearest ridge
  const L = layers[2];
  const wx = ((t * 0.012 + 0.18) % 1.2) * w - w * 0.1;
  const wy = h * L.base - fbm((wx / w) * L.f + t * L.sp, 5) * h * L.amp;
  const s = h * 0.055;
  const step = Math.sin(t * 3.2);
  g.fillStyle = "#120806";
  g.save();
  g.translate(wx, wy);
  g.beginPath();
  g.ellipse(0, -s * 1.02, s * 0.11, s * 0.13, 0, 0, Math.PI * 2); // head + hood
  g.fill();
  g.beginPath(); // cloak, flaring in the wind
  g.moveTo(-s * 0.13, -s * 0.9);
  g.quadraticCurveTo(-s * 0.26, -s * 0.4, -s * 0.22 - Math.sin(t * 2) * s * 0.04, -s * 0.18);
  g.lineTo(s * 0.18 + Math.sin(t * 2.3) * s * 0.06, -s * 0.2);
  g.quadraticCurveTo(s * 0.2, -s * 0.5, s * 0.12, -s * 0.9);
  g.closePath();
  g.fill();
  g.lineWidth = s * 0.07;
  g.strokeStyle = "#120806";
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(-s * 0.04, -s * 0.2);
  g.lineTo(-s * 0.04 + step * s * 0.1, 0);
  g.moveTo(s * 0.05, -s * 0.2);
  g.lineTo(s * 0.05 - step * s * 0.1, 0);
  g.moveTo(s * 0.12, -s * 0.7); // staff
  g.lineTo(s * 0.26, s * 0.02);
  g.stroke();
  g.restore();

  // blowing sand
  g.globalCompositeOperation = "lighter";
  sand.forEach((p) => {
    const x = (((p.x + t * p.v) % 1) + 1) % 1;
    const y = p.y + Math.sin(t * 0.7 + p.o * 9) * 0.01;
    g.fillStyle = `rgba(255,190,130,${0.15 + p.o * 0.25})`;
    g.fillRect(x * w, y * h, p.s * 2.4, p.s * 0.8);
  });
  g.globalCompositeOperation = "source-over";
}

/* ───────────── 2 · Low tide, a lighthouse at night ───────────── */

const seaStars = (() => {
  const r = rng(23);
  return Array.from({ length: 120 }, () => ({ x: r(), y: r() * 0.5, s: r() * 1.2 + 0.3, p: r() * 6 }));
})();

function lighthouse(g: G, w: number, h: number, t: number) {
  const hz = h * 0.6;
  g.fillStyle = vgrad(g, 0, hz, [
    [0, "#02040a"],
    [0.7, "#0a1830"],
    [1, "#1b3350"],
  ]);
  g.fillRect(0, 0, w, hz);
  seaStars.forEach((s) => {
    g.globalAlpha = 0.35 + 0.35 * Math.sin(t * 1.3 + s.p);
    g.fillStyle = "#dfe8ff";
    g.fillRect(s.x * w, s.y * hz, s.s, s.s);
  });
  g.globalAlpha = 1;
  // moon
  const mx = w * 0.28;
  const my = h * 0.22;
  g.globalCompositeOperation = "lighter";
  glow(g, mx, my, h * 0.45, "rgba(140,170,255,0.25)");
  g.globalCompositeOperation = "source-over";
  g.fillStyle = "#eef2ff";
  g.beginPath();
  g.arc(mx, my, h * 0.045, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "rgba(170,180,210,0.35)";
  g.beginPath();
  g.arc(mx - h * 0.012, my - h * 0.01, h * 0.012, 0, Math.PI * 2);
  g.arc(mx + h * 0.015, my + h * 0.012, h * 0.008, 0, Math.PI * 2);
  g.fill();

  // sea
  g.fillStyle = vgrad(g, hz, h, [
    [0, "#0d1d33"],
    [1, "#01040a"],
  ]);
  g.fillRect(0, hz, w, h - hz);
  // moonlight glitter: broken horizontal strokes widening towards the camera
  g.globalCompositeOperation = "lighter";
  for (let y = hz + 2; y < h; y += 3) {
    const d = (y - hz) / (h - hz);
    const spread = w * (0.02 + d * 0.16);
    const n = 3 + Math.floor(d * 6);
    for (let k = 0; k < n; k++) {
      const ph = noise1(y * 0.21 + k * 3.7 + t * 0.9, 4);
      const x = mx + ph * spread;
      const len = (4 + d * 26) * (0.5 + 0.5 * noise1(y * 0.13 + k + t * 1.7, 7));
      g.fillStyle = `rgba(200,215,255,${(0.55 - d * 0.35) * (0.5 + 0.5 * ph)})`;
      g.fillRect(x - len / 2, y, len, 1.2);
    }
  }
  g.globalCompositeOperation = "source-over";

  // headland + lighthouse
  const lx = w * 0.79;
  g.fillStyle = "#03060c";
  g.beginPath();
  g.moveTo(w * 0.58, hz + 2);
  g.bezierCurveTo(w * 0.66, hz - h * 0.03, w * 0.72, hz - h * 0.09, lx - w * 0.02, hz - h * 0.1);
  g.lineTo(w, hz - h * 0.13);
  g.lineTo(w, hz + h * 0.06);
  g.lineTo(w * 0.58, hz + 2);
  g.fill();
  const top = hz - h * 0.36;
  g.beginPath();
  g.moveTo(lx - w * 0.016, hz - h * 0.1);
  g.lineTo(lx - w * 0.009, top);
  g.lineTo(lx + w * 0.009, top);
  g.lineTo(lx + w * 0.016, hz - h * 0.1);
  g.fill();
  g.fillRect(lx - w * 0.013, top - h * 0.045, w * 0.026, h * 0.01);
  g.beginPath();
  g.moveTo(lx - w * 0.011, top - h * 0.045);
  g.lineTo(lx, top - h * 0.075);
  g.lineTo(lx + w * 0.011, top - h * 0.045);
  g.fill();
  // rotating beam: a soft cone that swells when it swings toward camera
  const ly = top - h * 0.025;
  const a = t * 0.9;
  const towards = Math.max(0, Math.cos(a));
  const side = Math.sin(a);
  g.globalCompositeOperation = "lighter";
  const reach = w * 1.1;
  const spread = 0.05 + towards * 0.12;
  const dir = side >= 0 ? 0 : Math.PI;
  const grd = g.createRadialGradient(lx, ly, 0, lx, ly, reach);
  grd.addColorStop(0, `rgba(255,240,190,${0.55 + towards * 0.3})`);
  grd.addColorStop(0.4, "rgba(255,230,170,0.12)");
  grd.addColorStop(1, "rgba(255,230,170,0)");
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(lx, ly);
  g.arc(lx, ly, reach, dir - spread + side * 0.02, dir + spread + side * 0.02);
  g.closePath();
  g.globalAlpha = Math.abs(side) * 0.9 + 0.1;
  g.fill();
  g.globalAlpha = 1;
  glow(g, lx, ly, h * (0.05 + towards * 0.35), "rgba(255,240,200,0.9)", 0.4 + towards * 0.6);
  g.globalCompositeOperation = "source-over";

  // drifting sea fog
  for (let i = 0; i < 3; i++) {
    const x = ((t * (8 + i * 5) + i * 300) % (w + 600)) - 300;
    g.globalAlpha = 0.1;
    glow(g, x, hz + h * (0.02 + i * 0.05), w * 0.35, "rgba(150,170,200,0.6)");
  }
  g.globalAlpha = 1;
}

/* ───────────── 3 · Ghost frequency: a neon city in the rain ───────────── */

type Bldg = { x: number; w: number; h: number; win: Array<[number, number, number]>; sign?: { c: string; y: number; w: number; f: number } };
function skyline(seed: number, n: number, minH: number, maxH: number, signs: boolean): Bldg[] {
  const r = rng(seed);
  const out: Bldg[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    const bw = 0.05 + r() * 0.09;
    const bh = minH + r() * (maxH - minH);
    const win: Array<[number, number, number]> = [];
    for (let wy = 0.03; wy < bh - 0.02; wy += 0.028) for (let wx = 0.012; wx < bw - 0.01; wx += 0.016) if (r() < 0.38) win.push([wx, wy, r()]);
    const pal = ["#ff2d95", "#00e5ff", "#ff9f0a", "#bf5af2", "#30d158"];
    out.push({ x, w: bw, h: bh, win, sign: signs && r() < 0.55 ? { c: pal[Math.floor(r() * pal.length)], y: 0.1 + r() * (bh - 0.2), w: 0.02 + r() * 0.03, f: r() } : undefined });
    x += bw + 0.004;
  }
  return out;
}
const CITY = [skyline(5, 40, 0.15, 0.35, false), skyline(9, 30, 0.25, 0.5, false), skyline(13, 22, 0.3, 0.62, true)];
const rain = (() => {
  const r = rng(31);
  return Array.from({ length: 260 }, () => ({ x: r(), y: r(), l: 0.02 + r() * 0.05, v: 1.1 + r() * 0.8, o: 0.15 + r() * 0.35 }));
})();

function neon(g: G, w: number, h: number, t: number) {
  const street = h * 0.74;
  g.fillStyle = vgrad(g, 0, street, [
    [0, "#05030c"],
    [0.6, "#1a0b2e"],
    [1, "#3a1340"],
  ]);
  g.fillRect(0, 0, w, street);
  g.globalCompositeOperation = "lighter";
  glow(g, w * 0.5, street, w * 0.6, "rgba(255,45,149,0.18)");
  g.globalCompositeOperation = "source-over";

  const tints = ["#140b22", "#0d0717", "#06040b"];
  const pan = [0.004, 0.009, 0.016];
  CITY.forEach((layer, li) => {
    const total = layer[layer.length - 1].x + layer[layer.length - 1].w + 0.004;
    const off = (t * pan[li]) % total;
    for (const copy of [0, 1]) {
      for (const b of layer) {
        const bx = (b.x - off + copy * total) * w;
        const bw = b.w * w;
        if (bx > w || bx + bw < 0) continue;
        const by = street - b.h * h;
        g.fillStyle = tints[li];
        g.fillRect(bx, by, bw, b.h * h);
        // lit windows; a few flicker
        for (const [wx, wy, k] of b.win) {
          const on = k > 0.08 || Math.sin(t * 3 + k * 50) > 0;
          if (!on) continue;
          g.fillStyle = li === 2 ? (k > 0.5 ? "rgba(255,210,150,0.75)" : "rgba(120,200,255,0.55)") : `rgba(255,200,160,${0.18 + li * 0.12})`;
          g.fillRect(bx + wx * w, by + wy * h, w * 0.006, h * 0.012);
        }
        if (b.sign) {
          const flick = b.sign.f > 0.7 && Math.sin(t * 13 + b.sign.f * 40) > 0.6 ? 0.25 : 1;
          const sx = bx + bw * 0.5 - (b.sign.w * w) / 2;
          const sy = by + b.sign.y * h * 0.4;
          g.globalCompositeOperation = "lighter";
          glow(g, sx + (b.sign.w * w) / 2, sy + h * 0.03, h * 0.12, b.sign.c, 0.35 * flick);
          g.globalCompositeOperation = "source-over";
          g.strokeStyle = b.sign.c;
          g.globalAlpha = flick;
          g.lineWidth = 2;
          g.shadowColor = b.sign.c;
          g.shadowBlur = 12;
          g.strokeRect(sx, sy, b.sign.w * w, h * 0.06);
          g.shadowBlur = 0;
          g.globalAlpha = 1;
          // reflection on the wet street
          const rg = g.createLinearGradient(0, street, 0, h);
          rg.addColorStop(0, b.sign.c);
          rg.addColorStop(1, "rgba(0,0,0,0)");
          g.globalCompositeOperation = "lighter";
          g.globalAlpha = 0.16 * flick;
          g.fillStyle = rg;
          g.fillRect(sx + Math.sin(t * 2 + sx) * 2, street, b.sign.w * w, h - street);
          g.globalAlpha = 1;
          g.globalCompositeOperation = "source-over";
        }
      }
    }
  });

  // wet asphalt
  g.fillStyle = vgrad(g, street, h, [
    [0, "rgba(20,10,30,0.55)"],
    [1, "rgba(2,1,4,0.95)"],
  ]);
  g.fillRect(0, street, w, h - street);
  // passing car: headlights sweep across, tail lights trail
  const cx = (((t * 0.22) % 1.6) - 0.3) * w;
  const cy = street + h * 0.07;
  g.globalCompositeOperation = "lighter";
  glow(g, cx, cy, h * 0.2, "rgba(255,245,220,0.55)");
  glow(g, cx - w * 0.07, cy + 2, h * 0.08, "rgba(255,40,40,0.6)");
  g.fillStyle = "rgba(255,240,210,0.25)";
  g.fillRect(cx - w * 0.3, cy + h * 0.04, w * 0.3, 1.5);
  g.globalCompositeOperation = "source-over";

  // rain
  g.strokeStyle = "rgba(190,210,255,0.5)";
  g.lineWidth = 1;
  g.beginPath();
  rain.forEach((d) => {
    const y = ((d.y + t * d.v) % 1) * h;
    const x = ((d.x + (t * d.v * 0.12)) % 1) * w;
    g.globalAlpha = d.o;
    g.moveTo(x, y);
    g.lineTo(x - d.l * h * 0.15, y + d.l * h);
  });
  g.stroke();
  g.globalAlpha = 1;
}

/* ───────────── 4 · Northern lights over a frozen lake ───────────── */

const arctic = (() => {
  const r = rng(41);
  return {
    stars: Array.from({ length: 220 }, () => ({ x: r(), y: r() * 0.6, s: 0.3 + r() * 1.3, p: r() * 6 })),
    snow: Array.from({ length: 120 }, () => ({ x: r(), y: r(), s: 0.6 + r() * 1.8, v: 0.03 + r() * 0.06, p: r() * 6 })),
    pines: Array.from({ length: 34 }, (_, i) => ({ x: i / 34 + r() * 0.02, h: 0.06 + r() * 0.08 })),
  };
})();
let auroraSprite: HTMLCanvasElement | null = null;
function sprite() {
  if (auroraSprite) return auroraSprite;
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "rgba(160,80,255,0)");
  grd.addColorStop(0.45, "rgba(120,90,255,0.25)");
  grd.addColorStop(0.8, "rgba(60,255,170,0.75)");
  grd.addColorStop(0.95, "rgba(170,255,210,1)");
  grd.addColorStop(1, "rgba(170,255,210,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 256);
  auroraSprite = c;
  return c;
}

function aurora(g: G, w: number, h: number, t: number) {
  const lake = h * 0.7;
  g.fillStyle = vgrad(g, 0, lake, [
    [0, "#01030b"],
    [0.6, "#03121c"],
    [1, "#0a2a2e"],
  ]);
  g.fillRect(0, 0, w, lake);
  arctic.stars.forEach((s) => {
    g.globalAlpha = 0.3 + 0.4 * Math.sin(t * 1.1 + s.p);
    g.fillStyle = "#fff";
    g.fillRect(s.x * w, s.y * lake, s.s, s.s);
  });
  g.globalAlpha = 1;

  // aurora curtains: columns of a vertical gradient sprite riding a slow, folding noise curve
  const sp = sprite();
  g.globalCompositeOperation = "lighter";
  const bands = [
    { base: 0.3, amp: 0.1, len: 0.32, sp: 0.06, seed: 1, a: 0.5 },
    { base: 0.4, amp: 0.08, len: 0.24, sp: -0.045, seed: 4, a: 0.35 },
    { base: 0.22, amp: 0.06, len: 0.2, sp: 0.03, seed: 8, a: 0.25 },
  ];
  const col = Math.max(2, Math.round(w / 260));
  for (const b of bands) {
    for (let x = 0; x < w; x += col) {
      const u = x / w;
      const y = h * (b.base + fbm(u * 2.2 + t * b.sp, b.seed) * b.amp);
      const len = h * b.len * (0.55 + 0.45 * (0.5 + 0.5 * fbm(u * 5 - t * 0.12, b.seed + 3)));
      const a = b.a * (0.35 + 0.65 * (0.5 + 0.5 * noise1(u * 14 + t * 0.6, b.seed + 5)));
      g.globalAlpha = a;
      g.drawImage(sp, x, y - len, col + 1, len);
      // the lake mirrors it, dimmer
      g.globalAlpha = a * 0.28;
      g.drawImage(sp, x, lake + (lake - y) * 0.55, col + 1, -len * 0.5);
    }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";

  // mountains with snow-lit ridges
  ridge(g, w, h, lake - h * 0.06, h * 0.13, 2.4, 0.3, 21, vgrad(g, lake - h * 0.25, lake, [[0, "#0e2a33"], [1, "#04121a"]]), 1);
  ridge(g, w, h, lake - h * 0.01, h * 0.07, 3.1, 1.7, 33, vgrad(g, lake - h * 0.1, lake, [[0, "#061820"], [1, "#020a0e"]]), 1);
  // frozen lake
  g.fillStyle = vgrad(g, lake, h, [
    [0, "rgba(8,30,36,0.85)"],
    [1, "rgba(1,4,6,1)"],
  ]);
  g.fillRect(0, lake, w, h - lake);
  // pine line on the near shore
  g.fillStyle = "#010406";
  arctic.pines.forEach((p) => {
    const px = p.x * w;
    const ph = p.h * h;
    const by = lake + h * 0.012;
    g.beginPath();
    g.moveTo(px - ph * 0.22, by);
    g.lineTo(px, by - ph);
    g.lineTo(px + ph * 0.22, by);
    g.fill();
  });
  // a cabin with a warm window
  const cx = w * 0.72;
  const cy = lake + h * 0.005;
  g.fillStyle = "#020507";
  g.fillRect(cx, cy - h * 0.05, w * 0.05, h * 0.05);
  g.beginPath();
  g.moveTo(cx - w * 0.006, cy - h * 0.05);
  g.lineTo(cx + w * 0.025, cy - h * 0.085);
  g.lineTo(cx + w * 0.056, cy - h * 0.05);
  g.fill();
  const flick = 0.85 + Math.sin(t * 7) * 0.05 + Math.sin(t * 11.3) * 0.05;
  g.globalCompositeOperation = "lighter";
  glow(g, cx + w * 0.032, cy - h * 0.026, h * 0.08, "rgba(255,170,80,0.7)", flick);
  g.globalCompositeOperation = "source-over";
  g.fillStyle = `rgba(255,190,110,${flick})`;
  g.fillRect(cx + w * 0.027, cy - h * 0.034, w * 0.011, h * 0.016);
  // warm reflection on the ice
  g.globalAlpha = 0.25 * flick;
  g.fillStyle = "#ffb060";
  g.fillRect(cx + w * 0.029, lake + h * 0.02, w * 0.007, h * 0.08);
  g.globalAlpha = 1;
  // snow
  arctic.snow.forEach((s) => {
    const y = ((s.y + t * s.v) % 1) * h;
    const x = (s.x + Math.sin(t * 0.5 + s.p) * 0.01) * w;
    g.globalAlpha = 0.5;
    g.fillStyle = "#e8f6ff";
    g.beginPath();
    g.arc(x, y, s.s, 0, Math.PI * 2);
    g.fill();
  });
  g.globalAlpha = 1;
}

/* ───────────── shared grade ───────────── */

let grain: HTMLCanvasElement[] | null = null;
function grainFrames() {
  if (grain) return grain;
  grain = [0, 1, 2, 3].map((k) => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const img = g.createImageData(128, 128);
    const r = rng(100 + k);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = r() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  });
  return grain;
}

const SCENES = [dunes, lighthouse, neon, aurora];

/** Draws one frame of `scene` at time `t` (seconds) into a w×h canvas context. */
export function drawScene(g: G, scene: SceneId, w: number, h: number, t: number, grade = true) {
  g.save();
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
  // slow push-in, like a dolly
  const z = 1.04 + Math.sin(t * 0.05) * 0.02;
  g.translate(w / 2, h / 2);
  g.scale(z, z);
  g.translate(-w / 2, -h / 2);
  SCENES[scene](g, w, h, t);
  g.restore();
  if (!grade) return;
  // vignette
  const v = g.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.75);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.7)");
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
  // film grain
  const frames = grainFrames();
  const pat = g.createPattern(frames[Math.floor(t * 24) % frames.length], "repeat");
  if (pat) {
    g.globalAlpha = 0.07;
    g.globalCompositeOperation = "overlay";
    g.fillStyle = pat;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
  }
}
