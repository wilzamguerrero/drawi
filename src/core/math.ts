/** Utilidades numéricas compartidas por render, física y trazo. */

export const TAU = Math.PI * 2;
export const EPS = 1e-9;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  Math.abs(b - a) < EPS ? 0 : (v - a) / (b - a);

export const remap = (v: number, a: number, b: number, c: number, d: number): number =>
  lerp(c, d, clamp01(invLerp(a, b, v)));

export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const smootherstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** Interpolación exponencial independiente del framerate. */
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Mínimo suave polinómico (raíz del efecto metaball con formas). */
export const smin = (a: number, b: number, k: number): number => {
  if (k <= EPS) return Math.min(a, b);
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
};

/** Igual que `smin` pero devuelve además el peso de mezcla (para color). */
export const sminBlend = (a: number, b: number, k: number): { d: number; h: number } => {
  if (k <= EPS) return { d: Math.min(a, b), h: a < b ? 1 : 0 };
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return { d: lerp(b, a, h) - k * h * (1 - h), h };
};

/** Máximo suave: usado para restar materia sin aristas. */
export const smax = (a: number, b: number, k: number): number => -smin(-a, -b, k);

/** Envuelve un ángulo a (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
};

/** Diferencia angular más corta entre dos ángulos. */
export const angleDelta = (a: number, b: number): number => wrapAngle(b - a);

/** Curva de respuesta con forma de "gamma" simétrica alrededor de 0.5. */
export const shapeCurve = (t: number, amount: number): number => {
  const x = clamp01(t);
  if (Math.abs(amount) < 1e-4) return x;
  const g = Math.exp(-amount * 1.6);
  return Math.pow(x, g);
};

export const approxEq = (a: number, b: number, eps = 1e-6): boolean =>
  Math.abs(a - b) <= eps;

export const roundTo = (v: number, step: number): number =>
  step <= 0 ? v : Math.round(v / step) * step;

/** Formatea un número para JSON/SVG sin ruido de coma flotante. */
export const fmt = (v: number, digits = 2): string => {
  const s = v.toFixed(digits);
  return s.replace(/\.?0+$/, "") || "0";
};
