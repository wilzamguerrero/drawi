/**
 * Objetos del espacio: primitivas con transformacion.
 *
 * El modelo guarda PARAMETROS, no mallas: un cubo es "cubo de lado tal", no una
 * lista de triangulos. La malla es derivada -la construye el backend-, igual que
 * los segmentos de un trazo lo son de sus puntos. De ahi salen dos cosas: el
 * archivo guarda la intencion y no el resultado de triangular, y editar el objeto
 * es cambiar un numero, no regenerar geometria a mano.
 *
 * La transformacion se guarda descompuesta -posicion, rotacion en euler, escala-
 * y no como matriz, porque es lo que el gizmo manipula y lo que la interfaz
 * enseña. La matriz se compone cuando hace falta dibujar.
 */

import type { V3 } from "./vec3";

export type PrimitiveKind = "box" | "sphere" | "cylinder" | "cone" | "plane" | "torus";

export const PRIMITIVE_LABELS: Record<PrimitiveKind, string> = {
  box: "Cubo",
  sphere: "Esfera",
  cylinder: "Cilindro",
  cone: "Cono",
  plane: "Plano",
  torus: "Toro",
};

export const PRIMITIVE_ORDER: PrimitiveKind[] = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "plane",
  "torus",
];

/** Transformacion de un objeto, descompuesta como la enseña cualquier editor 3D. */
export interface Transform3D {
  position: V3;
  /** Rotacion en euler XYZ, en radianes. */
  rotation: V3;
  scale: V3;
}

export interface Object3D {
  id: string;
  kind: PrimitiveKind;
  layerId: string;
  /** Nombre visible en el panel de capas. */
  name: string;
  transform: Transform3D;
  color: string;
  /** Opacidad propia, 0..1: una primitiva de referencia suele querer ir translucida. */
  opacity: number;
  /** No se dibuja, pero sigue en la escena -util para andamiajes que estorban-. */
  hidden: boolean;
}

export const IDENTITY_TRANSFORM = (): Transform3D => ({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

/** Lado base de una primitiva recien creada, en unidades de mundo. */
export const DEFAULT_PRIMITIVE_SIZE = 120;

export const makeObject = (
  kind: PrimitiveKind,
  id: string,
  layerId: string,
  over: Partial<Object3D> = {},
): Object3D => ({
  id,
  kind,
  layerId,
  name: PRIMITIVE_LABELS[kind],
  transform: IDENTITY_TRANSFORM(),
  // Opaca por defecto: una primitiva es un objeto solido de la escena, no un
  // andamio translucido. La transparencia se ajusta, si se quiere, desde la
  // opacidad de su capa en el panel.
  color: "#8aa0c0",
  opacity: 1,
  hidden: false,
  ...over,
});

/** Copia honda de una transformacion, para el historial. */
export const cloneTransform = (t: Transform3D): Transform3D => ({
  position: { ...t.position },
  rotation: { ...t.rotation },
  scale: { ...t.scale },
});

export const cloneObject = (o: Object3D): Object3D => ({
  ...o,
  transform: cloneTransform(o.transform),
});
