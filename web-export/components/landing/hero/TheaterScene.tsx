"use client";

/**
 * The hero theater: a curved panoramic display wall running a concave carousel of posters,
 * backlit silhouettes of viewers, and a glossy black floor with soft vertical reflections.
 * Everything animates in useFrame without React re-renders.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { ShowPoster } from "@/lib/landing";

// Wall geometry: a vertical cylinder segment seen from inside (concave toward the audience).
const R = 16;
const ARC = 1.72;
const CZ = 2;
const WALL_Y0 = 1.0;
const WALL_H = 7.2;
const WALL_TOP = WALL_Y0 + WALL_H;
/** World height of a point `f` (0 = top, 1 = bottom) down the wall. */
const yAt = (f: number) => WALL_TOP - f * WALL_H;
const LOOK = new THREE.Vector3(0, 2.8, -14);

// Shared, mutable "what is on screen" colour: lights, haze and rim lights follow it.
const ambient = { color: new THREE.Color("#5a46b4"), target: new THREE.Color("#5a46b4") };

/* ───────────── canvas textures ───────────── */

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function wrapLines(g: CanvasRenderingContext2D, text: string, maxW: number) {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function generatedTexture(p: ShowPoster, w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const [a, b] = p.hues;
  const lin = g.createLinearGradient(0, 0, 0, h);
  lin.addColorStop(0, b);
  lin.addColorStop(1, "#000");
  g.fillStyle = lin;
  g.fillRect(0, 0, w, h);
  const rad = g.createRadialGradient(w * 0.3, h * 0.2, 0, w * 0.3, h * 0.2, Math.max(w, h) * 0.8);
  rad.addColorStop(0, a + "dd");
  rad.addColorStop(1, "transparent");
  g.fillStyle = rad;
  g.fillRect(0, 0, w, h);
  // a lone figure on a horizon, so the art reads as a "poster"
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(0, h * 0.62, w, h * 0.38);
  g.fillStyle = "#000";
  g.beginPath();
  g.ellipse(w * 0.62, h * 0.555, w * 0.025, w * 0.03, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(w * 0.6, h * 0.58, w * 0.04, h * 0.05);
  g.fillStyle = "#fff";
  const size = Math.round(w * (h > w ? 0.13 : 0.085));
  g.font = `italic ${size}px Georgia, serif`;
  const lines = wrapLines(g, p.title, w * 0.84);
  lines.forEach((l, i) => g.fillText(l, w * 0.08, h - w * 0.1 - (lines.length - 1 - i) * size * 1.05));
  g.font = `${Math.round(size * 0.38)}px monospace`;
  g.fillStyle = "rgba(255,255,255,0.65)";
  g.fillText(String(p.year ?? ""), w * 0.08, w * 0.14);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function averageColor(img: HTMLImageElement) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 6;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 6, 6);
    const d = g.getImageData(0, 0, 6, 6).data;
    let r = 0,
      gg = 0,
      b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      gg += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    const col = new THREE.Color(r / n / 255, gg / n / 255, b / n / 255);
    // Push towards a saturated, bright light colour.
    const hsl = { h: 0, s: 0, l: 0 };
    col.getHSL(hsl);
    return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.6 + 0.15), 0.55);
  } catch {
    return null;
  }
}

/** The streaming interface painted on the wall (top bar, rail, row labels). */
function wallTexture() {
  const W = 3400;
  const H = Math.round((W * WALL_H) / (R * ARC));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0c0c14");
  bg.addColorStop(1, "#06060a");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, W * 0.45);
  glow.addColorStop(0, "rgba(120,100,255,0.16)");
  glow.addColorStop(1, "transparent");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  const y2px = (y: number) => ((WALL_TOP - y) / WALL_H) * H;
  // top bar
  g.fillStyle = "rgba(255,255,255,0.07)";
  roundRect(g, 150, 26, W - 300, 74, 26);
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.14)";
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = "#fff";
  g.font = "600 40px -apple-system, Segoe UI, sans-serif";
  g.fillText("Omnia", 200, 77);
  g.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(g, 360, 40, 560, 46, 20);
  g.fill();
  g.fillStyle = "rgba(255,255,255,0.45)";
  g.font = "26px -apple-system, Segoe UI, sans-serif";
  g.fillText("Movies, shows, people…", 400, 72);
  g.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(g, 960, 40, 470, 46, 18);
  g.fill();
  g.fillStyle = "rgba(255,255,255,0.18)";
  roundRect(g, 1200, 44, 226, 38, 15);
  g.fill();
  g.fillStyle = "rgba(255,255,255,0.6)";
  g.fillText("My Subscriptions", 990, 72);
  g.fillStyle = "#fff";
  g.fillText("All Platforms", 1232, 72);
  g.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(g, W - 300, 40, 110, 46, 20);
  g.fill();
  g.fillStyle = "#fff";
  g.fillText("◍  US", W - 278, 72);

  // left rail
  g.fillStyle = "rgba(255,255,255,0.05)";
  roundRect(g, 40, 26, 80, H - 60, 26);
  g.fill();
  for (let i = 0; i < 7; i++) {
    g.fillStyle = i === 1 ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.28)";
    g.beginPath();
    g.arc(80, 140 + i * 74, i === 1 ? 15 : 12, 0, Math.PI * 2);
    g.fill();
  }

  // row labels
  g.fillStyle = "#fff";
  g.font = "600 44px -apple-system, Segoe UI, sans-serif";
  g.fillText("Top 10 Today", 200, y2px(yAt(0.174)));
  g.fillText("Continue Watching", 200, y2px(yAt(0.679)));
  g.font = "26px -apple-system, Segoe UI, sans-serif";
  g.fillStyle = "rgba(255,255,255,0.5)";
  g.fillText("Across every service you pay for", 520, y2px(yAt(0.174)));
  g.fillText("Netflix · Prime Video · Apple TV+ · to the second", 640, y2px(yAt(0.679)));

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.x = -1; // seen from inside the cylinder
  t.anisotropy = 8;
  return t;
}

/* ───────────── the wall ───────────── */

function Wall() {
  const tex = useMemo(() => wallTexture(), []);
  const geo = useMemo(() => new THREE.CylinderGeometry(R, R, WALL_H, 128, 1, true, Math.PI - ARC / 2, ARC), []);
  const edgeGeo = useMemo(() => new THREE.CylinderGeometry(R + 0.02, R + 0.02, 0.025, 128, 1, true, Math.PI - ARC / 2, ARC), []);
  return (
    <group position={[0, 0, CZ]}>
      <mesh geometry={geo} position={[0, WALL_Y0 + WALL_H / 2, 0]}>
        <meshBasicMaterial map={tex} side={THREE.DoubleSide} toneMapped={false} fog={false} />
      </mesh>
      {[WALL_Y0, WALL_TOP].map((y) => (
        <mesh key={y} geometry={edgeGeo} position={[0, y, 0]}>
          <meshBasicMaterial color="#bcb6ff" side={THREE.BackSide} transparent opacity={0.35} toneMapped={false} fog={false} />
        </mesh>
      ))}
    </group>
  );
}

type Row = { kind: "poster" | "card"; y: number; w: number; h: number; speed: number; gap: number };
const TOP_ROW: Row = { kind: "poster", y: yAt(0.415), w: 1.86, h: 2.79, speed: 0.02, gap: 0.4 };
const CW_ROW: Row = { kind: "card", y: yAt(0.836), w: 2.2, h: 1.24, speed: -0.013, gap: 0.34 };

function Carousel({ posters, row, reduced }: { posters: ShowPoster[]; row: Row; reduced: boolean }) {
  const group = useRef<THREE.Group>(null);
  const hovered = useRef(-1);
  const step = (row.w + row.gap) / R;
  const items = useMemo(() => {
    // enough items to cover the arc and a little beyond
    const need = Math.ceil((ARC + 0.5) / step);
    return Array.from({ length: need }, (_, i) => posters[i % posters.length]);
  }, [posters, step]);
  const span = items.length * step;

  const mats = useMemo(
    () =>
      items.map((p) => {
        const tex = row.kind === "poster" ? generatedTexture(p, 256, 384) : generatedTexture(p, 400, 225);
        return new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, fog: false, side: THREE.DoubleSide });
      }),
    [items, row.kind],
  );
  const colors = useMemo(() => items.map((p) => new THREE.Color(p.hues[0])), [items]);
  const progress = useMemo(() => items.map((_, i) => 0.18 + ((i * 37) % 70) / 100), [items]);

  useEffect(() => {
    let alive = true;
    const loader = new THREE.TextureLoader();
    items.forEach((p, i) => {
      const url = row.kind === "poster" ? p.poster : p.backdrop;
      if (!url) return;
      loader.load(url, (t) => {
        if (!alive) return void t.dispose();
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        const old = mats[i].map;
        mats[i].map = t;
        mats[i].needsUpdate = true;
        old?.dispose();
        const c = averageColor(t.image as HTMLImageElement);
        if (c) colors[i].copy(c);
      });
    });
    return () => {
      alive = false;
      mats.forEach((m) => {
        m.map?.dispose();
        m.dispose();
      });
    };
  }, [items, mats, colors, row.kind]);

  const plane = useMemo(() => new THREE.PlaneGeometry(row.w, row.h), [row.w, row.h]);
  const bar = useMemo(() => new THREE.PlaneGeometry(1, 0.045), []);

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;
    const t = state.clock.elapsedTime * (reduced ? 0.15 : 1);
    const offset = (((t * row.speed) % span) + span) % span;
    let focus = -1;
    let best = Infinity;
    g.children.forEach((child, i) => {
      const theta = Math.PI - span / 2 + ((i * step + offset) % span);
      const off = Math.abs(theta - Math.PI);
      const vis = 1 - THREE.MathUtils.smoothstep(off + step * 0.5, ARC / 2 - 0.1, ARC / 2);
      if (off < best) {
        best = off;
        focus = i;
      }
      const lift = (child.userData.lift = THREE.MathUtils.damp(child.userData.lift ?? 0, hovered.current === i ? 1 : 0, 6, dt));
      const rr = R - 0.06 - lift * 0.5;
      child.position.set(rr * Math.sin(theta), row.y + lift * 0.08, CZ + rr * Math.cos(theta));
      child.rotation.y = theta + Math.PI;
      const s = 1 + lift * 0.1;
      child.scale.setScalar(s);
      child.visible = vis > 0.001;
      const mesh = child.children[0] as THREE.Mesh;
      (mesh.material as THREE.MeshBasicMaterial).opacity = vis;
      for (let k = 1; k < child.children.length; k++) ((child.children[k] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = vis * (k === 1 ? 0.3 : 1);
    });
    if (row.kind === "poster" && focus >= 0) ambient.target.copy(colors[hovered.current >= 0 ? hovered.current : focus]);
  });

  return (
    <group ref={group}>
      {items.map((p, i) => (
        <group key={i}>
          <mesh
            geometry={plane}
            material={mats[i]}
            onPointerOver={(e) => {
              e.stopPropagation();
              hovered.current = i;
            }}
            onPointerOut={() => {
              if (hovered.current === i) hovered.current = -1;
            }}
          />
          {row.kind === "card" && (
            <>
              <mesh geometry={bar} position={[0, -row.h / 2 + 0.09, 0.002]} scale={[row.w - 0.16, 1, 1]}>
                <meshBasicMaterial color="#ffffff" transparent toneMapped={false} fog={false} />
              </mesh>
              <mesh geometry={bar} position={[-(row.w - 0.16) / 2 + ((row.w - 0.16) * progress[i]) / 2, -row.h / 2 + 0.09, 0.004]} scale={[(row.w - 0.16) * progress[i], 1, 1]}>
                <meshBasicMaterial color="#ffffff" transparent toneMapped={false} fog={false} />
              </mesh>
            </>
          )}
        </group>
      ))}
    </group>
  );
}

/* ───────────── people ───────────── */

/*
 * Viewers are seen from behind, lit only by the screen. Each body is a hand-drawn back-view
 * outline (neck, trapezius, deltoids, waist, hips, tapering legs, feet) extruded with a deep
 * rounded bevel, so the rim light catches a soft, continuous edge the way a real backlit
 * silhouette does. Arms are separate tapered limbs hinged at the shoulder.
 */

const rimVertex = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying float vY;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vY = wp.y;
    vec4 mv = viewMatrix * wp;
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const rimFragment = /* glsl */ `
  uniform vec3 uRim; uniform float uStrength;
  varying vec3 vN; varying vec3 vV; varying float vY;
  void main() {
    float f = pow(1.0 - clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 3.2);
    float up = smoothstep(0.0, 1.9, vY) * 0.8 + 0.2;
    vec3 c = vec3(0.003) + uRim * f * uStrength * up;
    gl_FragColor = vec4(c, 1.0);
  }`;

type V2 = [number, number];
type ArmPose = "down" | "pocket" | "hip" | "point" | "phone" | "hold" | "reach";
type Build = { sh: number; wa: number; hp: number };
const BUILDS = {
  m: { sh: 0.205, wa: 0.142, hp: 0.152 },
  f: { sh: 0.172, wa: 0.118, hp: 0.168 },
  c: { sh: 0.16, wa: 0.14, hp: 0.145 },
} satisfies Record<string, Build>;

type PersonSpec = {
  x: number;
  z: number;
  h: number;
  turn: number;
  build: keyof typeof BUILDS;
  armL: ArmPose;
  armR: ArmPose;
  /** Leg spread (metres at the feet) for each leg. */
  stL: number;
  stR: number;
  /** Hem height of a coat / dress, if any. */
  hem?: number;
  hair: "short" | "long" | "bun";
  /** Head tilted down (looking at a phone). */
  down?: boolean;
  phase: number;
};

const PEOPLE: PersonSpec[] = [
  { x: -4.6, z: -1.2, h: 1.8, turn: 0.25, build: "m", armL: "down", armR: "pocket", stL: 0.03, stR: 0.06, hem: 0.58, hair: "short", phase: 0 },
  { x: -2.75, z: -3.4, h: 1.68, turn: 0.1, build: "f", armL: "down", armR: "hold", stL: 0.02, stR: 0.03, hair: "long", phase: 1.3 },
  { x: -2.22, z: -3.3, h: 1.14, turn: 0.04, build: "c", armL: "reach", armR: "down", stL: 0.03, stR: 0.03, hair: "short", phase: 2.2 },
  { x: 0.4, z: -0.6, h: 1.84, turn: -0.05, build: "m", armL: "pocket", armR: "pocket", stL: 0.07, stR: 0.07, hair: "short", phase: 0.7 },
  { x: 2.6, z: -3.9, h: 1.74, turn: -0.2, build: "m", armL: "down", armR: "point", stL: 0.04, stR: 0.02, hair: "short", phase: 2.9 },
  { x: 3.25, z: -3.6, h: 1.63, turn: -0.28, build: "f", armL: "hip", armR: "down", stL: 0.0, stR: 0.03, hem: 0.62, hair: "bun", phase: 3.6 },
  { x: 5.6, z: -1.6, h: 1.8, turn: -0.4, build: "m", armL: "phone", armR: "phone", stL: 0.04, stR: 0.04, hair: "short", down: true, phase: 4.4 },
  { x: -7.2, z: -4.8, h: 1.7, turn: 0.45, build: "f", armL: "down", armR: "down", stL: 0.02, stR: 0.04, hem: 0.5, hair: "long", phase: 5.1 },
  { x: 7.4, z: -5.4, h: 1.7, turn: -0.5, build: "m", armL: "pocket", armR: "down", stL: 0.05, stR: 0.02, hair: "short", phase: 6.0 },
];

/** Right half of a back-view body outline, from the neck down to the crotch (x > 0). */
function halfOutline(b: Build, st: number, hem?: number): V2[] {
  const leg = (x: number, y: number, k: number): V2 => [x + st * k, y];
  const top: V2[] = [
    [0.05, 1.54],
    [0.075, 1.5],
    [0.135, 1.468],
    [b.sh - 0.02, 1.445],
    [b.sh, 1.415],
    [b.sh + 0.008, 1.37],
    [b.sh - 0.012, 1.3],
    [b.wa + 0.022, 1.17],
    [b.wa, 1.07],
    [b.hp - 0.004, 0.97],
    [b.hp, 0.9],
  ];
  if (hem) {
    // coat / dress: flares slightly to the hem, then the legs continue below it
    const flare = b.hp + 0.03;
    return [
      ...top,
      [b.hp + 0.012, 0.8],
      [flare, hem + 0.02],
      [flare - 0.01, hem],
      leg(0.105, hem - 0.03, (0.8 - hem + 0.03) / 0.8),
      leg(0.11, 0.36, 0.55),
      leg(0.074, 0.1, 0.88),
      leg(0.088, 0.03, 0.96),
      leg(0.082, 0.0, 1),
      leg(0.028, 0.0, 1),
      leg(0.034, 0.1, 0.88),
      leg(0.038, 0.32, 0.6),
      leg(0.036, hem - 0.03, (0.8 - hem + 0.03) / 0.8),
      [0.0, hem - 0.008],
    ];
  }
  return [
    ...top,
    [b.hp - 0.008, 0.8],
    leg(b.hp - 0.03, 0.66, 0.18),
    leg(0.112, 0.5, 0.38),
    leg(0.116, 0.37, 0.55),
    leg(0.074, 0.1, 0.88),
    leg(0.088, 0.03, 0.96),
    leg(0.082, 0.0, 1),
    leg(0.028, 0.0, 1),
    leg(0.034, 0.1, 0.88),
    leg(0.04, 0.32, 0.6),
    leg(0.034, 0.5, 0.38),
    leg(0.026, 0.7, 0.12),
    [0.0, 0.79],
  ];
}

function bodyShape(b: Build, stL: number, stR: number, hem?: number) {
  const right = halfOutline(b, stR, hem);
  const left = halfOutline(b, stL, hem).map(([x, y]): V2 => [-x, y]).reverse();
  const pts = [...right, ...left.slice(1)].map(([x, y]) => new THREE.Vector2(x, y));
  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  s.splineThru([...pts.slice(1), pts[0]]);
  return s;
}

/** A tapered limb through a chain of joints, with rounded ends. */
function limbShape(chain: V2[], widths: number[]) {
  const L: THREE.Vector2[] = [];
  const Rr: THREE.Vector2[] = [];
  const dir = (a: V2, b: V2) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l] as V2;
  };
  chain.forEach((p, i) => {
    const [dx, dy] = dir(chain[Math.max(0, i - 1)], chain[Math.min(chain.length - 1, i + 1)]);
    const w = widths[i] / 2;
    L.push(new THREE.Vector2(p[0] - dy * w, p[1] + dx * w));
    Rr.push(new THREE.Vector2(p[0] + dy * w, p[1] - dx * w));
  });
  const n = chain.length;
  const [ex, ey] = dir(chain[n - 2], chain[n - 1]);
  const tip = new THREE.Vector2(chain[n - 1][0] + ex * widths[n - 1] * 0.5, chain[n - 1][1] + ey * widths[n - 1] * 0.5);
  const [sx, sy] = dir(chain[1], chain[0]);
  const cap = new THREE.Vector2(chain[0][0] + sx * widths[0] * 0.45, chain[0][1] + sy * widths[0] * 0.45);
  const pts = [cap, ...L, tip, ...Rr.reverse()];
  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  s.splineThru([...pts.slice(1), pts[0]]);
  return s;
}

/** Shoulder → elbow → wrist → knuckles, for the right arm (x outward). */
const ARMS: Record<ArmPose, { chain: V2[]; w: number[] }> = {
  down: { chain: [[0, 0], [0.035, -0.29], [0.045, -0.54], [0.04, -0.66]], w: [0.112, 0.078, 0.052, 0.064] },
  pocket: { chain: [[0, 0], [0.065, -0.27], [0.0, -0.45], [-0.04, -0.5]], w: [0.112, 0.08, 0.056, 0.05] },
  hip: { chain: [[0, 0], [0.16, -0.21], [0.05, -0.4], [0.0, -0.43]], w: [0.112, 0.082, 0.056, 0.064] },
  point: { chain: [[0, 0], [0.13, 0.18], [0.25, 0.4], [0.29, 0.5]], w: [0.108, 0.076, 0.05, 0.044] },
  phone: { chain: [[0, 0], [0.05, -0.27], [-0.05, -0.35], [-0.1, -0.36]], w: [0.112, 0.082, 0.056, 0.05] },
  hold: { chain: [[0, 0], [0.08, -0.28], [0.15, -0.5], [0.17, -0.6]], w: [0.112, 0.078, 0.052, 0.064] },
  reach: { chain: [[0, 0], [0.1, -0.17], [0.2, -0.3], [0.24, -0.34]], w: [0.12, 0.085, 0.06, 0.07] },
};

const BODY_EXTRUDE = { depth: 0.14, bevelEnabled: true, bevelThickness: 0.055, bevelSize: 0.03, bevelSegments: 6, curveSegments: 64 };
const LIMB_EXTRUDE = { depth: 0.05, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.018, bevelSegments: 5, curveSegments: 32 };

function extrude(shape: THREE.Shape, opts: THREE.ExtrudeGeometryOptions) {
  const g = new THREE.ExtrudeGeometry(shape, opts);
  g.translate(0, 0, -(opts.depth ?? 0) / 2);
  g.computeVertexNormals();
  return g;
}

function Person({ spec, mat }: { spec: PersonSpec; mat: THREE.Material }) {
  const root = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const child = spec.build === "c";
  const s = spec.h / (child ? 1.38 : 1.75);
  const b = BUILDS[spec.build];
  const geos = useMemo(() => {
    const arm = (p: ArmPose) => extrude(limbShape(ARMS[p].chain, ARMS[p].w), LIMB_EXTRUDE);
    return {
      body: extrude(bodyShape(b, spec.stL, spec.stR, spec.hem), BODY_EXTRUDE),
      armL: arm(spec.armL),
      armR: arm(spec.armR),
      head: new THREE.SphereGeometry(0.1, 28, 20),
      ear: new THREE.SphereGeometry(0.024, 10, 8),
      nose: new THREE.SphereGeometry(0.02, 10, 8),
      hair: new THREE.SphereGeometry(0.106, 24, 16),
      bun: new THREE.SphereGeometry(0.048, 16, 12),
    };
  }, [b, spec]);
  useEffect(() => () => Object.values(geos).forEach((g) => g.dispose()), [geos]);

  useFrame((state) => {
    const t = state.clock.elapsedTime + spec.phase;
    if (root.current) {
      root.current.rotation.z = Math.sin(t * 0.45) * 0.01; // weight shift
      root.current.position.x = spec.x + Math.sin(t * 0.3) * 0.015;
      root.current.scale.y = s * (1 + Math.sin(t * 1.1) * 0.0035); // breathing
    }
    if (head.current) {
      head.current.rotation.y = Math.sin(t * 0.21) * 0.3 + (Math.sin(t * 0.07) > 0.85 ? 0.55 : 0);
      head.current.rotation.x = spec.down ? 0.42 : Math.sin(t * 0.17) * 0.04;
    }
    if (armR.current && spec.armR === "point") armR.current.rotation.z = Math.sin(t * 0.8) * 0.05;
  });

  const shoulderY = 1.42;
  const pivotX = b.sh - 0.035;
  const headScale = child ? 1.22 : 1;
  return (
    <group ref={root} position={[spec.x, 0, spec.z]} rotation={[0, spec.turn, 0]} scale={s}>
      <mesh geometry={geos.body} material={mat} />
      {/* arms sit just behind the torso (the camera sees the viewers' backs) */}
      <group position={[-pivotX, shoulderY, -0.035]} scale={[-1, 1, 1]}>
        <mesh geometry={geos.armL} material={mat} />
      </group>
      <group ref={armR} position={[pivotX, shoulderY, -0.035]}>
        <mesh geometry={geos.armR} material={mat} />
      </group>
      <group ref={head} position={[0, 1.555, 0]} scale={headScale}>
        <mesh geometry={geos.head} material={mat} position={[0, 0.095, 0]} scale={[0.86, 1.1, 0.98]} />
        <mesh geometry={geos.ear} material={mat} position={[-0.085, 0.09, 0]} scale={[0.6, 1.25, 0.9]} />
        <mesh geometry={geos.ear} material={mat} position={[0.085, 0.09, 0]} scale={[0.6, 1.25, 0.9]} />
        {/* the face looks at the screen (-z): the nose only shows when the head turns */}
        <mesh geometry={geos.nose} material={mat} position={[0, 0.075, -0.098]} scale={[0.8, 1.2, 1.3]} />
        {spec.hair === "long" && <mesh geometry={geos.hair} material={mat} position={[0, 0.03, 0.022]} scale={[0.92, 1.45, 0.85]} />}
        {spec.hair === "bun" && <mesh geometry={geos.bun} material={mat} position={[0, 0.2, 0.06]} />}
        {spec.hair === "short" && <mesh geometry={geos.hair} material={mat} position={[0, 0.115, 0.008]} scale={[0.88, 0.95, 0.98]} />}
      </group>
    </group>
  );
}

function Audience() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uRim: { value: new THREE.Color("#8a7dff") }, uStrength: { value: 1.25 } },
        vertexShader: rimVertex,
        fragmentShader: rimFragment,
        side: THREE.DoubleSide,
      }),
    [],
  );
  const white = useMemo(() => new THREE.Color("#ffffff"), []);
  useFrame(() => {
    (mat.uniforms.uRim.value as THREE.Color).copy(ambient.color).lerp(white, 0.25);
  });
  return (
    <group>
      {PEOPLE.map((p, i) => (
        <Person key={i} spec={p} mat={mat} />
      ))}
    </group>
  );
}

/* ───────────── night sky ───────────── */

const starVertex = /* glsl */ `
  attribute float aSize; attribute float aPhase;
  uniform float uTime;
  varying float vTw;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vTw = 0.55 + 0.45 * sin(uTime * (0.6 + fract(aPhase * 7.3) * 1.6) + aPhase * 6.2831);
    gl_PointSize = aSize * (260.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const starFragment = /* glsl */ `
  uniform float uOpacity;
  varying float vTw;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vec3(1.0), a * a * vTw * uOpacity);
  }`;

function streakTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 16;
  const g = c.getContext("2d")!;
  const lin = g.createLinearGradient(0, 0, 256, 0);
  lin.addColorStop(0, "rgba(255,255,255,0)");
  lin.addColorStop(0.75, "rgba(200,215,255,0.35)");
  lin.addColorStop(0.97, "rgba(255,255,255,1)");
  lin.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = lin;
  // thin core, softer halo
  g.globalAlpha = 0.3;
  g.fillRect(0, 3, 256, 10);
  g.globalAlpha = 0.6;
  g.fillRect(0, 6, 256, 4);
  g.globalAlpha = 1;
  g.fillRect(0, 7, 256, 2);
  // bright head
  const head = g.createRadialGradient(246, 8, 0, 246, 8, 8);
  head.addColorStop(0, "rgba(255,255,255,1)");
  head.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = head;
  g.fillRect(230, 0, 26, 16);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

type Shot = { t0: number; dur: number; from: THREE.Vector3; dir: THREE.Vector3; speed: number; len: number };

/** Faint twinkling stars above the screen, and an occasional shooting star. */
function Sky({ reduced }: { reduced: boolean }) {
  const stars = useMemo(() => {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 120;
      pos[i * 3 + 1] = 5 + Math.random() * 30;
      pos[i * 3 + 2] = -28 - Math.random() * 22;
      size[i] = 0.35 + Math.pow(Math.random(), 6) * 1.6;
      phase[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    return g;
  }, []);
  const starMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uOpacity: { value: 0.75 } },
        vertexShader: starVertex,
        fragmentShader: starFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  const tex = useMemo(() => streakTexture(), []);
  const meshes = useRef<Array<THREE.Mesh | null>>([]);
  const shots = useRef<Array<Shot | null>>([null, null]);
  const next = useRef(1.2);
  useEffect(
    () => () => {
      stars.dispose();
      starMat.dispose();
      tex.dispose();
    },
    [stars, starMat, tex],
  );

  useFrame((state) => {
    const now = state.clock.elapsedTime;
    starMat.uniforms.uTime.value = reduced ? 0 : now;
    if (reduced) return;
    // A shooting star every 2–3 s. Spawned in screen space, in the strip of sky between the top
    // of the screen wall and the top of the frame, then placed far behind the wall so the wall
    // occludes it naturally if it dips down.
    if (now > next.current) {
      const slot = shots.current.findIndex((x) => !x);
      if (slot >= 0) {
        const cam = state.camera;
        // clear sky: below the floating nav bar (~76px), above the middle of the wall's top edge
        const wallTop = new THREE.Vector3(0, WALL_TOP, CZ - R).project(cam).y;
        const navBottom = 1 - (2 * 76) / state.size.height;
        const lo = wallTop + 0.03;
        const hi = Math.max(lo + 0.02, navBottom - 0.02);
        const ndcY = lo + Math.random() * (hi - lo);
        const left = Math.random() < 0.5;
        const ndcX = (left ? -1 : 1) * (0.15 + Math.random() * 0.4);
        const p = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(cam);
        const from = cam.position.clone().add(p.sub(cam.position).normalize().multiplyScalar(42));
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
        // travel toward the centre of the frame, falling gently
        const dir = right.multiplyScalar(left ? 1 : -1).addScaledVector(up, -(0.06 + Math.random() * 0.06)).normalize();
        shots.current[slot] = { t0: now, dur: 0.9 + Math.random() * 0.4, from, dir, speed: 26 + Math.random() * 8, len: 5 + Math.random() * 3 };
      }
      next.current = now + 2 + Math.random();
    }
    shots.current.forEach((s, i) => {
      const m = meshes.current[i];
      if (!m) return;
      if (!s) {
        m.visible = false;
        return;
      }
      const e = now - s.t0;
      const p = e / s.dur;
      if (p >= 1) {
        shots.current[i] = null;
        m.visible = false;
        return;
      }
      const head = s.from.clone().addScaledVector(s.dir, s.speed * e);
      const len = s.len * Math.min(1, p * 3.5);
      m.visible = true;
      m.position.copy(head).addScaledVector(s.dir, -len / 2);
      // lie in the camera's plane, pointing along the direction of travel
      m.quaternion.copy(state.camera.quaternion);
      const sx = s.dir.dot(new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0));
      const sy = s.dir.dot(new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 1));
      m.rotateZ(Math.atan2(sy, sx));
      m.scale.set(len, 0.2, 1);
      (m.material as THREE.MeshBasicMaterial).opacity = Math.min(1, Math.sin(Math.PI * p) * 1.3);
    });
  });

  return (
    <>
      <points geometry={stars} material={starMat} />
      {[0, 1].map((i) => (
        <mesh key={i} ref={(el) => void (meshes.current[i] = el)} visible={false}>
          <planeGeometry />
          <meshBasicMaterial map={tex} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} fog={false} />
        </mesh>
      ))}
    </>
  );
}

/* ───────────── atmosphere ───────────── */

function radialTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.35, "rgba(255,255,255,0.35)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function Atmosphere({ reduced }: { reduced: boolean }) {
  const tex = useMemo(() => radialTexture(), []);
  const haze = useRef<THREE.MeshBasicMaterial>(null);
  const pool = useRef<THREE.MeshBasicMaterial>(null);
  const light = useRef<THREE.PointLight>(null);
  const dust = useRef<THREE.Points>(null);
  const dustGeo = useMemo(() => {
    const n = 420;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 24;
      pos[i * 3 + 1] = Math.random() * 9;
      pos[i * 3 + 2] = -12 + Math.random() * 16;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);

  useFrame((state, dt) => {
    ambient.color.lerp(ambient.target, 1 - Math.exp(-dt * 1.2));
    haze.current?.color.copy(ambient.color);
    pool.current?.color.copy(ambient.color);
    light.current?.color.copy(ambient.color);
    if (dust.current && !reduced) {
      dust.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.05) * 0.05;
      dust.current.position.y = Math.sin(state.clock.elapsedTime * 0.2) * 0.08;
    }
  });

  return (
    <>
      {/* screen glow behind the posters */}
      <mesh position={[0, 4.4, -7]} scale={[30, 12, 1]}>
        <planeGeometry />
        <meshBasicMaterial ref={haze} map={tex} transparent opacity={0.13} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      {/* light pool spilling onto the floor */}
      <mesh position={[0, 0.012, -7]} rotation={[-Math.PI / 2, 0, 0]} scale={[34, 16, 1]}>
        <planeGeometry />
        <meshBasicMaterial ref={pool} map={tex} transparent opacity={0.12} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <pointLight ref={light} position={[0, 4.5, -9]} intensity={18} distance={30} decay={1.6} />
      <points ref={dust} geometry={dustGeo}>
        <pointsMaterial size={0.025} color="#ffffff" transparent opacity={0.35} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
      </points>
    </>
  );
}

const floorVertex = /* glsl */ `
  uniform mat4 uTexMatrix;
  varying vec4 vProj; varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vProj = uTexMatrix * wp;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const floorFragment = /* glsl */ `
  uniform sampler2D tReflect; uniform float uStrength; uniform vec3 uCam;
  varying vec4 vProj; varying vec3 vWorld;
  void main() {
    vec2 uv = vProj.xy / vProj.w;
    float dist = distance(vWorld.xz, uCam.xz);
    // Soft vertical smear: wider the further the floor point is from the screen wall.
    float spread = 0.0016 + 0.00032 * clamp(vWorld.z + 14.0, 0.0, 20.0);
    // per-pixel jitter hides the individual taps
    float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    vec3 acc = vec3(0.0); float wsum = 0.0;
    for (int i = -10; i <= 10; i++) {
      float k = float(i) + j;
      float w = exp(-k * k / 40.0);
      acc += texture2D(tReflect, uv + vec2(k * spread * 0.12, k * spread)).rgb * w;
      wsum += w;
    }
    vec3 refl = acc / wsum;
    // Fade into pure black with distance (and towards the viewer's feet).
    float fade = (1.0 - smoothstep(10.0, 34.0, dist)) * smoothstep(1.0, 6.0, dist);
    gl_FragColor = vec4(refl * uStrength * fade, 1.0);
  }`;

/**
 * Glossy black floor: a mirrored virtual camera renders the room into a small target each frame
 * and the floor samples it with a vertical blur (soft, streaky, fading into black).
 */
function Floor({ mobile }: { mobile: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const { gl, scene, camera } = useThree();
  const rt = useMemo(() => new THREE.WebGLRenderTarget(mobile ? 384 : 768, mobile ? 384 : 768, { colorSpace: THREE.SRGBColorSpace }), [mobile]);
  const virtualCam = useMemo(() => new THREE.PerspectiveCamera(), []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { tReflect: { value: rt.texture }, uTexMatrix: { value: new THREE.Matrix4() }, uStrength: { value: 0.55 }, uCam: { value: new THREE.Vector3() } },
        vertexShader: floorVertex,
        fragmentShader: floorFragment,
      }),
    [rt],
  );
  const tmp = useMemo(() => ({ dir: new THREE.Vector3(), target: new THREE.Vector3(), bias: new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1) }), []);
  useEffect(() => () => {
    rt.dispose();
    mat.dispose();
  }, [rt, mat]);

  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.updateMatrixWorld();
    virtualCam.copy(cam);
    virtualCam.position.set(cam.position.x, -cam.position.y, cam.position.z);
    cam.getWorldDirection(tmp.dir);
    tmp.dir.y = -tmp.dir.y;
    tmp.target.copy(virtualCam.position).add(tmp.dir);
    virtualCam.up.set(0, -1, 0);
    virtualCam.lookAt(tmp.target);
    virtualCam.updateMatrixWorld();
    virtualCam.projectionMatrix.copy(cam.projectionMatrix);
    (mat.uniforms.uTexMatrix.value as THREE.Matrix4).copy(tmp.bias).multiply(virtualCam.projectionMatrix).multiply(virtualCam.matrixWorldInverse);
    (mat.uniforms.uCam.value as THREE.Vector3).copy(cam.position);

    if (!mesh.current) return;
    mesh.current.visible = false;
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(rt);
    gl.clear();
    gl.render(scene, virtualCam);
    gl.setRenderTarget(prev);
    mesh.current.visible = true;
  });

  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} material={mat}>
      <planeGeometry args={[90, 90]} />
    </mesh>
  );
}

function CameraRig({ reduced, mobile }: { reduced: boolean; mobile: boolean }) {
  const { camera, pointer } = useThree();
  const look = useRef(LOOK.clone());
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const scroll = typeof window === "undefined" ? 0 : Math.min(1, window.scrollY / window.innerHeight);
    const drift = reduced ? 0 : 1;
    const tx = pointer.x * 0.75 * drift + Math.sin(t * 0.06) * 0.35 * drift;
    const ty = 1.6 + pointer.y * 0.3 * drift + scroll * 0.8;
    const tz = (mobile ? 8.5 : 10.5) - scroll * 3.5 + Math.sin(t * 0.09) * 0.25 * drift;
    camera.position.x = THREE.MathUtils.damp(camera.position.x, tx, 2.2, dt);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, ty, 2.2, dt);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, tz, 2.2, dt);
    look.current.x = THREE.MathUtils.damp(look.current.x, pointer.x * 0.6 * drift, 2, dt);
    look.current.y = mobile ? 0.9 : LOOK.y;
    camera.lookAt(look.current);
  });
  return null;
}

export default function TheaterScene({ posters, active, reduced, mobile }: { posters: ShowPoster[]; active: boolean; reduced: boolean; mobile: boolean }) {
  const top = posters;
  const cw = useMemo(() => [...posters].reverse(), [posters]);
  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      dpr={[1, mobile ? 1.25 : 1.6]}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
      camera={{ position: [0, 1.7, 10.5], fov: mobile ? 50 : 40, near: 0.1, far: 90 }}
      onCreated={({ gl, scene }) => {
        gl.setClearColor("#000000");
        scene.fog = new THREE.Fog("#000000", 16, 40);
      }}
    >
      <ambientLight intensity={0.05} />
      <Wall />
      <Carousel posters={top} row={TOP_ROW} reduced={reduced} />
      <Carousel posters={cw} row={CW_ROW} reduced={reduced} />
      <Sky reduced={reduced} />
      <Audience />
      <Atmosphere reduced={reduced} />
      <Floor mobile={mobile} />
      <CameraRig reduced={reduced} mobile={mobile} />
    </Canvas>
  );
}
