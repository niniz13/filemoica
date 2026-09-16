export const N = 160;

export interface FileCatalogEntry {
  name: string;
  ext: string;
  mb: number;
  kind: string;
}

export const CAT: FileCatalogEntry[] = [
  { name: "lune_teaser_v4.mov", ext: "MOV", mb: 4820, kind: "Video" },
  { name: "cover_art_8k.psd", ext: "PSD", mb: 1340, kind: "Image" },
  { name: "stems_master.zip", ext: "ZIP", mb: 912, kind: "Archive" },
  { name: "contract_signed.pdf", ext: "PDF", mb: 3, kind: "Document" },
  { name: "shoot_raw_batch_02.zip", ext: "ZIP", mb: 7210, kind: "Photos" },
  { name: "board_v11.fig", ext: "FIG", mb: 88, kind: "Design" },
];

export const TILES: Record<string, [string, string]> = {
  MOV: ["#ece9ff", "#5b4bff"],
  PSD: ["#e6f1ff", "#1f5fa8"],
  ZIP: ["#efece7", "#6b7178"],
  PDF: ["#ffeceb", "#d2493c"],
  FIG: ["#eafaf1", "#0b6b45"],
};

export function fmt(mb: number): string {
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(0) + " MB";
}

export type Screen = "signin" | "drop" | "sending" | "sent" | "receive";

export interface Packet {
  x: number;
  y: number;
  v: number;
  label: string;
  mb: number;
  rot: number;
  rv: number;
  dead?: boolean;
}

export interface Spray {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
}

export interface Bubble {
  x: number;
  y: number;
  r: number;
  s: number;
  a: number;
}

export interface Engine {
  hf: Float32Array;
  vf: Float32Array;
  packets: Packet[];
  spray: Spray[];
  bubbles: Bubble[];
  p: number;
  tilt: number;
  tiltV: number;
  t: number;
  level: number | null;
  surfFn: ((i: number) => number) | null;
  hpx: number;
  lastUI: number;
  raf: number;
}

export function makeBubble(): Bubble {
  return {
    x: Math.random(),
    y: Math.random(),
    r: 0.6 + Math.random() * 2.2,
    s: 0.04 + Math.random() * 0.12,
    a: 0.05 + Math.random() * 0.14,
  };
}

export function createEngine(): Engine {
  const bubbles: Bubble[] = [];
  for (let i = 0; i < 24; i++) bubbles.push(makeBubble());
  return {
    hf: new Float32Array(N),
    vf: new Float32Array(N),
    packets: [],
    spray: [],
    bubbles,
    p: 0,
    tilt: 0,
    tiltV: 0,
    t: 0,
    level: null,
    surfFn: null,
    hpx: 0,
    lastUI: 0,
    raf: 0,
  };
}

export function dropPacket(engine: Engine, ext: string, mb: number) {
  engine.packets.push({
    x: 0.18 + Math.random() * 0.64,
    y: -0.18,
    v: 0,
    label: ext,
    mb,
    rot: (Math.random() - 0.5) * 0.5,
    rv: (Math.random() - 0.5) * 0.03,
  });
}

export function splashEngine(engine: Engine, xn: number, power: number, waveIntensity: number) {
  const i = Math.max(2, Math.min(N - 3, Math.round(xn * N)));
  const amp = power * waveIntensity;
  for (let k = -4; k <= 4; k++) {
    const w = 1 - Math.abs(k) / 5;
    engine.vf[i + k] = Math.max(-8, engine.vf[i + k] - amp * w * 0.6);
  }
  engine.tiltV += (xn - 0.5) * power * 0.06;
  for (let k = 0; k < Math.round(power * 1.4); k++) {
    engine.spray.push({
      x: xn,
      y: 0,
      vx: (Math.random() - 0.5) * 0.34,
      vy: -(0.5 + Math.random() * 1.5),
      r: 0.8 + Math.random() * 1.9,
      life: 1,
    });
  }
}

export interface StepContext {
  screen: Screen;
  fileCount: number;
  draining: boolean;
}

export function stepEngine(
  engine: Engine,
  dt: number,
  ctx: StepContext,
  waveIntensity: number,
  demoSpeed: number,
  onSendComplete: () => void,
) {
  const f = Math.min(1, dt / 16.67);
  const sc = ctx.screen;
  let target = 0.14;
  if (sc === "signin") target = 0.32;
  else if (sc === "drop") target = 0.1 + Math.min(0.42, ctx.fileCount * 0.075);
  else if (sc === "sending") {
    engine.p = Math.min(1, engine.p + 0.0022 * f * demoSpeed);
    target = 0.08 + engine.p * 0.8;
    if (Math.random() < 0.1 * f) dropPacket(engine, "·", 0);
    if (engine.p >= 1) onSendComplete();
  } else if (sc === "sent") {
    engine.p = 1;
    target = 0.88;
  } else if (sc === "receive") {
    if (ctx.draining) engine.p = Math.max(0, engine.p - 0.0024 * f * demoSpeed);
    target = 0.08 + engine.p * 0.8;
  }
  engine.level = engine.level == null ? target : engine.level + (target - engine.level) * 0.045 * f;

  for (const pk of engine.packets) {
    pk.v += 0.0011 * f;
    pk.y += pk.v * f;
    pk.rot += pk.rv * f;
    let sy = 1 - (engine.level ?? 0);
    if (engine.surfFn && engine.hpx) {
      const i = Math.max(0, Math.min(N - 1, Math.round(pk.x * (N - 1))));
      sy = engine.surfFn(i) / engine.hpx;
    }
    if (pk.y >= sy) {
      pk.dead = true;
      splashEngine(engine, pk.x, pk.mb ? 4.2 : 1.6, waveIntensity);
    }
  }
  engine.packets = engine.packets.filter((pk) => !pk.dead);

  const k = 0.16;
  const damp = 0.982;
  for (let i = 0; i < N; i++) {
    const a = engine.hf[i === 0 ? 0 : i - 1];
    const b = engine.hf[i === N - 1 ? N - 1 : i + 1];
    let v = engine.vf[i] + ((a + b) / 2 - engine.hf[i]) * k * f;
    v *= Math.pow(damp, f);
    if (!isFinite(v)) v = 0;
    engine.vf[i] = Math.max(-8, Math.min(8, v));
    let hv = engine.hf[i] + engine.vf[i] * f;
    if (!isFinite(hv)) hv = 0;
    engine.hf[i] = Math.max(-40, Math.min(40, hv));
  }
  if (Math.random() < 0.09 * f) engine.vf[Math.floor(Math.random() * N)] -= 0.35 * waveIntensity;
  engine.tiltV += -engine.tilt * 0.004 * f;
  engine.tiltV *= Math.pow(0.985, f);
  engine.tilt += engine.tiltV * f;

  for (const s of engine.spray) {
    s.vy += 0.075 * f;
    s.x += s.vx * 0.006 * f;
    s.y += s.vy * 0.01 * f;
    s.life -= 0.012 * f;
  }
  engine.spray = engine.spray.filter((s) => s.life > 0 && s.y < 0.6);
  for (const b of engine.bubbles) {
    b.y -= b.s * 0.006 * f;
    if (b.y < 0) {
      b.y = 1;
      b.x = Math.random();
    }
  }
}

export function drawEngine(engine: Engine, canvas: HTMLCanvasElement, accent: string) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const x = canvas.getContext("2d");
  if (!x) return;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);

  const level = engine.level ?? 0;
  const base = h * (1 - level);
  const surf = (i: number) =>
    base + engine.hf[i] * 1.5 + engine.tilt * (i / (N - 1) - 0.5) * 26 + Math.sin(engine.t / 900 + i * 0.09) * 2.4;

  engine.hpx = h;
  engine.surfFn = surf;

  x.beginPath();
  x.moveTo(0, h);
  for (let i = 0; i < N; i++) x.lineTo((i / (N - 1)) * w, surf(i));
  x.lineTo(w, h);
  x.closePath();
  const g = x.createLinearGradient(0, base - 40, 0, h);
  g.addColorStop(0, "#5f4fff");
  g.addColorStop(0.5, "#5241ee");
  g.addColorStop(1, "#4030c8");
  x.fillStyle = g;
  x.fill();

  x.save();
  x.clip();
  for (const b of engine.bubbles) {
    const by = base + b.y * (h - base);
    x.beginPath();
    x.arc(b.x * w, by, b.r, 0, 6.2832);
    x.fillStyle = `rgba(255,255,255,${b.a})`;
    x.fill();
  }
  x.restore();

  x.beginPath();
  for (let i = 0; i < N; i++) {
    const px = (i / (N - 1)) * w;
    const py = surf(i);
    if (i) x.lineTo(px, py);
    else x.moveTo(px, py);
  }
  x.strokeStyle = "rgba(255,255,255,0.85)";
  x.lineWidth = 1.4;
  x.stroke();

  for (const s of engine.spray) {
    x.beginPath();
    x.arc(s.x * w, base + s.y * h * 0.5, s.r, 0, 6.2832);
    x.fillStyle = `rgba(91,75,255,${s.life * 0.6})`;
    x.fill();
  }

  for (const pk of engine.packets) {
    const px = pk.x * w;
    const py = pk.y * h;
    x.save();
    x.translate(px, py);
    x.rotate(pk.rot);
    if (pk.mb) {
      x.fillStyle = "#ffffff";
      x.strokeStyle = "rgba(91,75,255,0.22)";
      x.lineWidth = 1;
      x.beginPath();
      x.roundRect(-21, -15, 42, 30, 10);
      x.fill();
      x.stroke();
      x.fillStyle = accent;
      x.font = '500 9.5px "Space Grotesk", sans-serif';
      x.textAlign = "center";
      x.fillText(pk.label, 0, 3.5);
    } else {
      x.fillStyle = "rgba(91,75,255,0.55)";
      x.beginPath();
      x.roundRect(-3, -7, 6, 14, 3);
      x.fill();
    }
    x.restore();
  }
}

export function drawQR(canvas: HTMLCanvasElement) {
  const M = 25;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = 132;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const x = canvas.getContext("2d");
  if (!x) return;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.fillStyle = "#ffffff";
  x.fillRect(0, 0, size, size);
  const pad = 6;
  const cell = (size - pad * 2) / M;
  let seed = 20240917;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const grid: boolean[][] = Array.from({ length: M }, () => Array.from({ length: M }, () => rnd() > 0.52));
  const finder = (r: number, c: number) => {
    for (let i = -1; i < 8; i++) {
      for (let j = -1; j < 8; j++) {
        const rr = r + i;
        const cc = c + j;
        if (rr < 0 || cc < 0 || rr >= M || cc >= M) continue;
        const edge = i === 0 || i === 6 || j === 0 || j === 6;
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        grid[rr][cc] = i >= 0 && i < 7 && j >= 0 && j < 7 ? edge || core : false;
      }
    }
  };
  finder(0, 0);
  finder(0, M - 7);
  finder(M - 7, 0);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < M; j++) {
      if (!grid[i][j]) continue;
      x.fillStyle = "#16181c";
      x.beginPath();
      x.roundRect(pad + j * cell, pad + i * cell, cell * 0.94, cell * 0.94, cell * 0.28);
      x.fill();
    }
  }
}
