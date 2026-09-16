export const N = 160;

export const TILES: Record<string, [string, string]> = {
  MOV: ["#ece9ff", "#5b4bff"],
  MP4: ["#ece9ff", "#5b4bff"],
  PSD: ["#e6f1ff", "#1f5fa8"],
  PNG: ["#e6f1ff", "#1f5fa8"],
  JPG: ["#e6f1ff", "#1f5fa8"],
  JPEG: ["#e6f1ff", "#1f5fa8"],
  ZIP: ["#efece7", "#6b7178"],
  RAR: ["#efece7", "#6b7178"],
  PDF: ["#ffeceb", "#d2493c"],
  DOC: ["#eaf1ff", "#1f5fa8"],
  DOCX: ["#eaf1ff", "#1f5fa8"],
  XLS: ["#eafaf1", "#0b6b45"],
  XLSX: ["#eafaf1", "#0b6b45"],
  FIG: ["#eafaf1", "#0b6b45"],
  TXT: ["#efece7", "#6b7178"],
};

export const FALLBACK_TILE: [string, string] = ["#efece7", "#6b7178"];

/** Formate un nombre d'octets en unité lisible (B / KB / MB / GB / TB). */
export function fmtBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = safe;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/** Extension d'un nom de fichier, en majuscules, pour la vignette colorée. */
export function extFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "FILE";
  return name.slice(dot + 1).toUpperCase().slice(0, 4);
}

export interface Packet {
  x: number;
  y: number;
  v: number;
  label: string;
  weight: number;
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

/** Fait tomber un paquet visuel représentant un vrai fichier déposé. */
export function dropPacket(engine: Engine, label: string, sizeMB: number) {
  engine.packets.push({
    x: 0.18 + Math.random() * 0.64,
    y: -0.18,
    v: 0,
    label,
    weight: Math.min(6, 2 + sizeMB / 100),
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

/**
 * Phase de l'animation, découplée de l'écran affiché :
 * - "signin"  : niveau décoratif fixe, avant connexion.
 * - "idle"    : reflète l'usage réel du quota (aucun envoi en cours).
 * - "active"  : reflète `engine.p` (0..1), piloté depuis l'extérieur par la
 *   progression réelle d'un envoi (XHR upload progress). L'engine ne modifie
 *   jamais `p` lui-même dans ce mode : c'est l'appelant qui le pousse à jour.
 */
export type EnginePhase = "signin" | "idle" | "active";

export interface StepContext {
  phase: EnginePhase;
  quotaFraction: number;
}

export function stepEngine(engine: Engine, dt: number, ctx: StepContext, waveIntensity: number) {
  const f = Math.min(1, dt / 16.67);
  let target = 0.14;
  if (ctx.phase === "signin") target = 0.32;
  else if (ctx.phase === "idle") {
    const frac = Number.isFinite(ctx.quotaFraction) ? Math.max(0, Math.min(1, ctx.quotaFraction)) : 0;
    target = 0.1 + frac * 0.6;
  } else if (ctx.phase === "active") {
    target = 0.08 + Math.max(0, Math.min(1, engine.p)) * 0.8;
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
      splashEngine(engine, pk.x, pk.weight, waveIntensity);
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
    x.restore();
  }
}
