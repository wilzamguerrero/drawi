/**
 * Rejilla del suelo.
 *
 * No es geometria de lineas, es un quad grande con la rejilla pintada en el
 * fragment shader. La diferencia importa:
 *
 *  - Una rejilla de lineas de verdad tiene que ser finita, y su borde se ve. Aqui
 *    el quad se coloca bajo la camara y las lineas se desvanecen por distancia
 *    antes de llegar a su borde, asi que no hay borde que ver.
 *  - Con `fwidth` las lineas salen con el grosor de un pixel mida lo que mida el
 *    paso en pantalla. Sin eso, al alejarse la rejilla se convierte en un moire
 *    que ensucia toda la imagen, que es el defecto clasico de las rejillas mal
 *    hechas.
 *
 * El quad se coloca en el vertex shader a partir del centro que se le pasa, asi
 * que seguir a la camara cuesta un uniforme y no una matriz.
 */

import * as THREE from "three";

const VERT = /* glsl */ `
precision highp float;

uniform mat4 uViewProjection;
uniform vec3 uCenter;
uniform float uSize;

varying vec3 vWorld;

void main() {
  // El quad base es de lado 1 y centrado; se estira y se lleva al suelo bajo el
  // centro que manda la CPU.
  vec3 world = vec3(
    uCenter.x + position.x * uSize,
    uCenter.y,
    uCenter.z + position.y * uSize
  );
  vWorld = world;
  gl_Position = uViewProjection * vec4(world, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec3 vWorld;

uniform vec3 uCenter;
uniform float uStep;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uOpacity;
uniform vec3 uColor;

/**
 * Cobertura de la rejilla en un punto del suelo.
 *
 * fwidth(q) es cuanto cambia q entre el pixel de al lado: dividir por el
 * convierte la distancia a la linea en "pixeles de distancia", y de ahi sale un
 * trazo de un pixel exacto a cualquier distancia. Es lo que hace que la rejilla
 * se vea igual de cerca que de lejos.
 */
float rejilla(vec2 p, float paso) {
  vec2 q = p / paso;
  vec2 d = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  return 1.0 - min(min(d.x, d.y), 1.0);
}

void main() {
  vec2 suelo = vWorld.xz;

  // Dos niveles: cada diez lineas, una mas marcada. Sin el segundo nivel, contar
  // cuadros de un vistazo es imposible.
  float menor = rejilla(suelo, uStep);
  float mayor = rejilla(suelo, uStep * 10.0);
  float linea = max(menor * 0.4, mayor);

  // Se apaga con la distancia: lejos, las lineas se juntan mas de lo que el pixel
  // puede resolver y sin esto la rejilla se convierte en una mancha gris.
  float dist = length(suelo - uCenter.xz);
  float fundido = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);

  float alfa = linea * fundido * uOpacity;
  if (alfa <= 0.001) discard;

  gl_FragColor = vec4(uColor * alfa, alfa);
}
`;

export interface GridOptions {
  /** Centro del suelo bajo el que se coloca el quad: el punto de mira, en XZ. */
  centerX: number;
  centerZ: number;
  /** Altura del suelo. */
  floorY: number;
  /** Paso de la rejilla menor, en unidades de mundo. */
  step: number;
  opacity: number;
}

export interface FloorGrid {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** Por debajo de todo lo demas: la rejilla es el suelo, no una capa. */
  renderOrder: number;
}

/**
 * Orden de dibujado de la rejilla.
 *
 * Por debajo de todos los lotes, que empiezan en cero: el suelo se pinta primero
 * y los trazos van encima. Es la misma regla que el resto del visor -orden de
 * pintado, sin z-buffer-, y es lo que hace que el suelo nunca tape un trazo.
 */
export const GRID_RENDER_ORDER = -1000;

/** Cuanto suelo cubre la rejilla, en multiplos del paso. */
const GRID_SPAN_STEPS = 60;

export const createFloorGrid = (): FloorGrid => {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uViewProjection: { value: new THREE.Matrix4() },
      uCenter: { value: new THREE.Vector3() },
      uSize: { value: 1 },
      uStep: { value: 50 },
      uFadeStart: { value: 1 },
      uFadeEnd: { value: 2 },
      uOpacity: { value: 0.5 },
      uColor: { value: new THREE.Color(0.42, 0.45, 0.52) },
    },
    transparent: true,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = GRID_RENDER_ORDER;
  mesh.visible = false;

  return { mesh, material, renderOrder: GRID_RENDER_ORDER };
};

/** Coloca la rejilla y ajusta su paso y su opacidad. */
export const updateFloorGrid = (grid: FloorGrid, opts: GridOptions): void => {
  const u = grid.material.uniforms;
  (u.uCenter.value as THREE.Vector3).set(opts.centerX, opts.floorY, opts.centerZ);

  // El quad cubre bastante mas de lo que se ve: el desvanecido tiene que terminar
  // dentro de el, o el borde del quad se convertiria en el borde de la rejilla.
  const alcance = Math.max(1, opts.step) * GRID_SPAN_STEPS;
  u.uSize.value = alcance * 2;
  u.uStep.value = Math.max(1e-3, opts.step);
  u.uFadeStart.value = alcance * 0.35;
  u.uFadeEnd.value = alcance * 0.9;
  u.uOpacity.value = opts.opacity;
};

export const disposeFloorGrid = (grid: FloorGrid): void => {
  grid.mesh.geometry.dispose();
  grid.material.dispose();
};
