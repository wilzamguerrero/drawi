/**
 * Control de camara del visor 3D y trazado de rayo para dibujar sobre un plano.
 *
 * Dos reglas gobiernan este modulo, y las dos vienen de la misma leccion: en una
 * aplicacion de dibujo, la camara y el trazo compiten por el mismo puntero.
 *
 *  1. **Navegar nunca dibuja.** Un gesto que mueve la camara se marca como
 *     consumido y la herramienta de dibujo no lo ve. Si no, cada orbita dejaria un
 *     trazo por el camino.
 *  2. **Dibujar no mueve la camara.** Solo el boton central, el derecho o la
 *     barra espaciadora navegan. El boton izquierdo y la punta del lapiz son
 *     siempre para dibujar.
 *
 * Todo es aritmetica sobre numeros: no hay tipos del DOM aqui, asi que los gestos
 * se pueden probar sin navegador.
 */

import { clamp } from "../core/math";
import { eyeOf, forwardOf, rightOf, upOf, zoom, pan, orbit, type Camera3DState } from "./camera3d";
import { normalize3, set3, v3, type V3 } from "./vec3";

/** Botones del puntero, con los valores del DOM. */
export const BUTTON_LEFT = 0;
export const BUTTON_MIDDLE = 1;
export const BUTTON_RIGHT = 2;

export type Gesture3D = "none" | "orbit" | "pan";

export interface Modifiers3D {
  shift: boolean;
  alt: boolean;
  /** Barra espaciadora: el gesto clasico de "mover la vista" con el lapiz. */
  space: boolean;
  /** El puntero es un lapiz o una pantalla tactil, no un raton. */
  pen: boolean;
}

export const NO_MODIFIERS: Modifiers3D = {
  shift: false,
  alt: false,
  space: false,
  pen: false,
};

/**
 * Decide si un boton navega o dibuja.
 *
 * Con lapiz la regla se invierte en parte: la punta siempre dibuja, y para
 * navegar se usa el boton lateral del lapiz o el espacio. Un ilustrador con
 * tableta no tiene rueda ni boton central a mano.
 */
export const navigatesWith = (button: number, mods: Modifiers3D): boolean => {
  if (mods.space) return true;
  if (button === BUTTON_MIDDLE || button === BUTTON_RIGHT) return true;
  // Con lapiz, el boton "izquierdo" es la punta: dibujar.
  return false;
};

/** El paneo necesita ademas un modificador o la rueda pulsada con shift. */
export const pansWith = (button: number, mods: Modifiers3D): boolean => {
  if (!navigatesWith(button, mods)) return false;
  return mods.shift;
};

export class CameraController3D {
  readonly state: Camera3DState;
  /** Altura del viewport, para convertir el desplazamiento a unidades de mundo. */
  viewportHeight = 800;

  private gesture: Gesture3D = "none";
  private lastX = 0;
  private lastY = 0;

  constructor(state: Camera3DState) {
    this.state = state;
  }

  /** true mientras el gesto en curso es de camara. */
  get navigating(): boolean {
    return this.gesture !== "none";
  }

  get current(): Gesture3D {
    return this.gesture;
  }

  /**
   * Empieza un gesto. Devuelve `true` si captura el puntero, en cuyo caso el
   * llamante NO debe pasar el evento a la herramienta de dibujo.
   */
  begin(button: number, mods: Modifiers3D, x: number, y: number): boolean {
    if (!navigatesWith(button, mods)) {
      this.gesture = "none";
      return false;
    }
    this.gesture = pansWith(button, mods) ? "pan" : "orbit";
    this.lastX = x;
    this.lastY = y;
    return true;
  }

  move(x: number, y: number, mods: Modifiers3D): void {
    if (this.gesture === "none") return;
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;

    // Soltar o pulsar shift a mitad de gesto cambia de orbitar a desplazar sin
    // tener que levantar el boton: es lo que espera cualquiera que venga de una
    // herramienta 3D.
    const wantPan = mods.shift;
    if (wantPan && this.gesture === "orbit") this.gesture = "pan";
    else if (!wantPan && this.gesture === "pan") this.gesture = "orbit";

    if (this.gesture === "pan") {
      pan(this.state, dx, dy, this.viewportHeight);
    } else {
      orbit(this.state, -dx * 0.006, -dy * 0.006);
    }
  }

  end(): void {
    this.gesture = "none";
  }

  /** Rueda o pellizco. `factor` mayor que 1 acerca. */
  zoomBy(factor: number): void {
    zoom(this.state, 1 / Math.max(1e-4, factor));
  }

  /**
   * Acerca manteniendo bajo el cursor el punto que se esta mirando.
   *
   * Acercar sin mas mueve el mundo bajo el cursor y obliga a recolocar la vista a
   * mano; es la diferencia entre un zoom que se siente y uno que se sufre.
   */
  zoomAt(factor: number, ndcX: number, ndcY: number, aspect: number): void {
    const before = this.projectToPlane(ndcX, ndcY, aspect);
    zoom(this.state, 1 / Math.max(1e-4, factor));
    const after = this.projectToPlane(ndcX, ndcY, aspect);
    if (!before || !after) return;
    this.state.px += before.x - after.x;
    this.state.py += before.y - after.y;
    this.state.pz += before.z - after.z;
  }

  /**
   * Punto del plano de dibujo bajo el cursor.
   *
   * El plano pasa por el punto de mira y mira a la camara: es el "papel" sobre el
   * que se dibuja cuando no hay una superficie elegida.
   */
  projectToPlane(ndcX: number, ndcY: number, aspect: number, out: V3 = v3()): V3 | null {
    return rayToCameraPlane(this.state, ndcX, ndcY, aspect, out);
  }
}

/**
 * Convierte coordenadas normalizadas de pantalla en un rayo del mundo.
 *
 * `ndc` va de -1 a 1 con el eje Y hacia arriba, que es el convenio de WebGL del
 * que ya viene el resto del proyecto.
 */
export const screenToRay = (
  cam: Camera3DState,
  ndcX: number,
  ndcY: number,
  aspect: number,
  origin: V3 = v3(),
  dir: V3 = v3(),
): { origin: V3; dir: V3 } => {
  const eye = eyeOf(cam, origin);
  const f = forwardOf(cam);
  const r = rightOf(cam);
  const u = upOf(cam);

  const tanV = Math.tan(cam.fovY * 0.5);
  const tanH = tanV * Math.max(1e-4, aspect);

  dir.x = f.x + r.x * (ndcX * tanH) + u.x * (ndcY * tanV);
  dir.y = f.y + r.y * (ndcX * tanH) + u.y * (ndcY * tanV);
  dir.z = f.z + r.z * (ndcX * tanH) + u.z * (ndcY * tanV);
  normalize3(dir, dir);

  return { origin: eye, dir };
};

/**
 * Interseccion de un rayo con un plano. Devuelve `null` si son paralelos o si el
 * plano queda detras de la camara.
 */
export const rayToPlane = (
  origin: V3,
  dir: V3,
  planePoint: V3,
  planeNormal: V3,
  out: V3 = v3(),
): V3 | null => {
  const den = dir.x * planeNormal.x + dir.y * planeNormal.y + dir.z * planeNormal.z;
  if (Math.abs(den) < 1e-9) return null;

  const dx = planePoint.x - origin.x;
  const dy = planePoint.y - origin.y;
  const dz = planePoint.z - origin.z;
  const t = (dx * planeNormal.x + dy * planeNormal.y + dz * planeNormal.z) / den;
  if (t <= 0) return null;

  return set3(out, origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
};

/**
 * Punto del plano de dibujo por defecto: el que pasa por el punto de mira y mira
 * a la camara.
 *
 * Es la eleccion que hace que dibujar "funcione" sin configurar nada: el trazo
 * aparece bajo el cursor, a la profundidad a la que se esta mirando. Fijar la
 * profundidad es lo que evita el problema clasico del boceto en el aire, donde sin
 * referencia el usuario pierde la profundidad y no acierta donde pinta.
 */
export const rayToCameraPlane = (
  cam: Camera3DState,
  ndcX: number,
  ndcY: number,
  aspect: number,
  out: V3 = v3(),
): V3 | null => {
  const o = v3();
  const d = v3();
  screenToRay(cam, ndcX, ndcY, aspect, o, d);
  const f = forwardOf(cam, v3());
  const point = set3(v3(), cam.px, cam.py, cam.pz);
  return rayToPlane(o, d, point, f, out);
};

/** Punto del plano de profundidad fija: el que permite separar trazos en Z. */
export const rayToDepthPlane = (
  cam: Camera3DState,
  ndcX: number,
  ndcY: number,
  aspect: number,
  depth: number,
  out: V3 = v3(),
): V3 | null => {
  const o = v3();
  const d = v3();
  screenToRay(cam, ndcX, ndcY, aspect, o, d);
  const f = forwardOf(cam, v3());
  const point = set3(
    v3(),
    cam.px + f.x * depth,
    cam.py + f.y * depth,
    cam.pz + f.z * depth,
  );
  return rayToPlane(o, d, point, f, out);
};

/** Redondea un valor a la rejilla de profundidad, para que los planos sean estables. */
export const snapDepth = (depth: number, step: number): number =>
  step <= 0 ? depth : Math.round(depth / step) * step;

/** Acota un factor de zoom a un rango sensato antes de aplicarlo. */
export const clampZoomFactor = (factor: number): number => clamp(factor, 0.05, 20);
