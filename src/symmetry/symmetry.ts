import { identity, multiply, reflectionAbout, rotationAround, type Mat2d } from "../core/mat2d";
import { clamp, TAU } from "../core/math";

export type SymmetryMode = "none" | "mirror" | "radial" | "kaleido";

export interface SymmetryState {
  mode: SymmetryMode;
  /** Origen del eje, en coordenadas de mundo: se puede arrastrar a cualquier sitio. */
  x: number;
  y: number;
  /** Angulo del eje en radianes. */
  angle: number;
  /** Numero de sectores para radial/caleidoscopio. */
  count: number;
  /** Muestra el gizmo sobre el lienzo. */
  visible: boolean;
  /** Bloquea el gizmo para que no se mueva sin querer. */
  locked: boolean;
}

export const DEFAULT_SYMMETRY: SymmetryState = {
  mode: "none",
  x: 0,
  y: 0,
  angle: 0,
  count: 6,
  visible: true,
  locked: false,
};

export const SYMMETRY_LABELS: Record<SymmetryMode, string> = {
  none: "Sin simetria",
  mirror: "Espejo",
  radial: "Radial",
  kaleido: "Caleidoscopio",
};

/**
 * Lista de transformaciones que genera la simetria activa.
 * La primera siempre es la identidad (el trazo que realmente dibujas).
 */
export function symmetryTransforms(s: SymmetryState): Mat2d[] {
  const out: Mat2d[] = [identity()];
  if (s.mode === "none") return out;

  const n = clamp(Math.round(s.count), 2, 64);

  if (s.mode === "mirror") {
    out.push(reflectionAbout(s.angle, s.x, s.y));
    return out;
  }

  if (s.mode === "radial") {
    for (let i = 1; i < n; i++) {
      out.push(rotationAround((TAU * i) / n, s.x, s.y));
    }
    return out;
  }

  // Caleidoscopio: cada sector rotado y su reflejo. Genera 2n copias.
  const mirror = reflectionAbout(s.angle, s.x, s.y);
  out.push(mirror);
  for (let i = 1; i < n; i++) {
    const rot = rotationAround((TAU * i) / n, s.x, s.y);
    out.push(rot);
    out.push(multiply(rot, mirror));
  }
  return out;
}

export function symmetryCopies(s: SymmetryState): number {
  if (s.mode === "none") return 1;
  if (s.mode === "mirror") return 2;
  const n = clamp(Math.round(s.count), 2, 64);
  return s.mode === "radial" ? n : n * 2;
}

/** Partes del gizmo que el usuario puede agarrar. */
export type SymmetryHandle = "origin" | "axis" | "count" | null;

export interface GizmoGeometry {
  /** Radio del disco central en px de pantalla. */
  originRadius: number;
  /** Distancia del tirador de angulo, en px de pantalla. */
  axisRadius: number;
  /** Distancia del tirador de sectores. */
  countRadius: number;
}

export const GIZMO: GizmoGeometry = {
  originRadius: 13,
  axisRadius: 84,
  countRadius: 120,
};

/** Devuelve que tirador del gizmo cae bajo un punto de pantalla. */
export function hitSymmetryHandle(
  screenX: number,
  screenY: number,
  originScreen: { x: number; y: number },
  axisScreenAngle: number,
  mode: SymmetryMode,
): SymmetryHandle {
  const dx = screenX - originScreen.x;
  const dy = screenY - originScreen.y;
  const d = Math.hypot(dx, dy);
  if (d <= GIZMO.originRadius + 6) return "origin";
  if (mode === "none") return null;

  const hx = originScreen.x + Math.cos(axisScreenAngle) * GIZMO.axisRadius;
  const hy = originScreen.y + Math.sin(axisScreenAngle) * GIZMO.axisRadius;
  if (Math.hypot(screenX - hx, screenY - hy) <= 14) return "axis";

  if (mode === "radial" || mode === "kaleido") {
    const cx = originScreen.x + Math.cos(axisScreenAngle + Math.PI / 2) * GIZMO.countRadius;
    const cy = originScreen.y + Math.sin(axisScreenAngle + Math.PI / 2) * GIZMO.countRadius;
    if (Math.hypot(screenX - cx, screenY - cy) <= 14) return "count";
  }
  return null;
}
