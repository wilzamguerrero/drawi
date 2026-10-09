/**
 * Cinta instanciada: el shader que convierte puntos en geometria.
 *
 * Esta es la pieza que decide el rendimiento. En vez de triangular el trazo en la
 * CPU, se sube **solo la lista de puntos** y cada instancia es un segmento: el
 * vertex shader lee sus dos extremos del mismo buffer y construye el quad el
 * mismo. Consecuencias:
 *
 *  - Una sola llamada de dibujado por lote.
 *  - Cero triangulacion en JavaScript. Añadir un trazo es escribir sus puntos.
 *  - Cero duplicacion: la GPU guarda los puntos, no los vertices. Entre 40 MB y
 *    400 MB de diferencia en un dibujo denso.
 *
 * Cada entrada del buffer es un segmento con sus dos extremos ya resueltos, asi
 * que la instancia `i` lee la entrada `i` y punto. Que el indice de instancia y el
 * de datos coincidan es lo que hace correcto el sistema: cuando el shader los
 * deducia por su cuenta, cualquier desplazamiento -un centinela, un rango
 * borrado- hacia que cada segmento leyera los puntos de otro trazo.
 *
 * El sombreado merece una nota. Una cinta es plana, y una cinta plana sombreada
 * como plana se ve como una tira de papel. Aqui se sombrea **como si fuera un
 * tubo**: la normal se interpola a lo largo del ancho y el borde se oscurece, con
 * lo que el trazo adquiere volumen sin pagar los vertices de un tubo real. Es el
 * truco que separa una cinta que parece pintura de una que parece plastico.
 */

import * as THREE from "three";
import { radiusAt, type Stroke3D } from "../scene3d/types";
import {
  IA_NRM,
  IA_POS,
  IA_RAD,
  IB_NRM,
  IB_POS,
  IB_RAD,
  INSTANCE_FLOATS,
  type StrokeBatch,
} from "../scene3d/batch";

/** Vértice base: `x` recorre el segmento (0 a 1), `y` cruza el ancho (-1 a 1). */
const QUAD = new Float32Array([
  0, -1, 0,
  1, -1, 0,
  1, 1, 0,
  0, 1, 0,
]);
const QUAD_INDEX = new Uint16Array([0, 1, 2, 0, 2, 3]);

const VERT = /* glsl */ `
precision highp float;

attribute vec3 aPosA;
attribute vec3 aNrmA;
attribute float aRadA;
attribute vec3 aPosB;
attribute vec3 aNrmB;
attribute float aRadB;

uniform mat4 uViewProjection;

varying vec3 vFacing;
varying vec3 vWidth;
varying vec3 vWorld;
varying float vSide;

void main() {
  float t = position.x;
  float side = position.y;

  vec3 pa = aPosA;
  vec3 pb = aPosB;
  vec3 seg = pb - pa;
  float segLen = length(seg);
  vec3 tangent = segLen > 1e-6 ? seg / segLen : vec3(1.0, 0.0, 0.0);

  // La normal guardada se ortogonaliza contra la tangente: el trazo puede curvarse
  // despues de que el marco se calculara, y sin esto la cinta se retuerce.
  vec3 nrm = mix(aNrmA, aNrmB, t);
  vec3 perp = nrm - tangent * dot(tangent, nrm);
  float pl = length(perp);
  vec3 facing = pl > 1e-5 ? perp / pl : vec3(0.0, 1.0, 0.0);

  vec3 width = cross(tangent, facing);
  float wl = length(width);
  width = wl > 1e-5 ? width / wl : vec3(1.0, 0.0, 0.0);

  float radius = mix(aRadA, aRadB, t);
  vec3 center = mix(pa, pb, t);
  vec3 world = center + width * (side * radius);

  vFacing = facing;
  vWidth = width;
  vWorld = world;
  vSide = side;

  gl_Position = uViewProjection * vec4(world, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec3 vFacing;
varying vec3 vWidth;
varying vec3 vWorld;
varying float vSide;

uniform vec3 uColor;
uniform vec3 uCameraPos;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uAmbient;
uniform float uOpacity;
uniform float uGloss;

void main() {
  // Perfil circular: la cinta se sombrea como un tubo del ancho de la cinta.
  float s = clamp(vSide, -1.0, 1.0);
  float c = sqrt(max(0.0, 1.0 - s * s));
  vec3 n = normalize(vFacing * c + vWidth * s);

  vec3 view = normalize(uCameraPos - vWorld);
  // La cinta es de una sola cara: se sombrea la que mira a la camara.
  if (dot(n, view) < 0.0) n = -n;

  vec3 L = normalize(-uLightDir);
  // Sombreado envolvente: la luz rodea el trazo en vez de cortarlo en seco, que es
  // lo que hace que una cinta se lea como materia y no como una cuchilla.
  float wrap = clamp((dot(n, L) + 0.45) / 1.45, 0.0, 1.0);
  vec3 diffuse = uLightColor * wrap;

  vec3 H = normalize(L + view);
  float spec = pow(max(dot(n, H), 0.0), 48.0) * uGloss;

  // Contorno: oscurece el borde para despegar el trazo del fondo.
  float rim = pow(1.0 - c, 2.0);
  vec3 col = uColor * (uAmbient + diffuse) + uLightColor * spec;
  col *= mix(1.0, 0.82, rim);

  // Alfa premultiplicado: el lienzo del visor se compone luego sobre el de tinta
  // con drawImage, y el navegador espera ese formato.
  gl_FragColor = vec4(col * uOpacity, uOpacity);
}
`;

export interface RibbonMaterialOptions {
  color: string;
  opacity: number;
  gloss: number;
}

export const createRibbonMaterial = (opts: RibbonMaterialOptions): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uViewProjection: { value: new THREE.Matrix4() },
      uColor: { value: new THREE.Color(opts.color) },
      uCameraPos: { value: new THREE.Vector3() },
      uLightDir: { value: new THREE.Vector3(0.4, -0.85, -0.35).normalize() },
      uLightColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.34, 0.35, 0.4) },
      uOpacity: { value: opts.opacity },
      uGloss: { value: opts.gloss },
    },
    transparent: true,
    premultipliedAlpha: true,
    // Orden de pintado, NO z-buffer.
    //
    // Todos los trazos de una misma sesion viven sobre el mismo plano de dibujo,
    // asi que son coplanares. Con el z-buffer activo eso es z-fighting puro, y
    // ademas el rango de profundidad util (de 4 a 54.000 unidades) deja muy poca
    // precision a la distancia de trabajo: dos trazos coplanares acaban
    // rechazandose unos a otros de forma intermitente.
    //
    // Se dibujan en orden de creacion y se dejan superponer, que es justo lo que
    // hace que un trazo se lea como materia puesta encima de otra. Es la misma
    // decision que toma el look "pintura" de Tilt Brush y Feather.
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

export interface RibbonGeometry {
  geometry: THREE.InstancedBufferGeometry;
  /** La revision del lote que ya esta en la GPU. */
  revision: number;
  /** El array que se subio. Si el lote crece, cambia y hay que rehacer todo. */
  source: Float32Array;
}

/**
 * Crea la geometria instanciada de un lote.
 *
 * Las dos vistas intercaladas apuntan al MISMO array, la segunda un punto mas
 * adelante, asi que la instancia `i` lee el punto `i` por `a*A` y el `i+1` por
 * `a*B` sin duplicar un solo byte.
 */
export const createRibbonGeometry = (batch: StrokeBatch): RibbonGeometry => {
  const geometry = new THREE.InstancedBufferGeometry();

  geometry.setAttribute("position", new THREE.BufferAttribute(QUAD, 3));
  geometry.setIndex(new THREE.BufferAttribute(QUAD_INDEX, 1));

  // Una sola vista intercalada: la instancia `i` es el segmento `i`. Sin vistas
  // desplazadas y sin indices que puedan desincronizarse.
  const buf = new THREE.InstancedInterleavedBuffer(batch.data, INSTANCE_FLOATS, 1);
  geometry.setAttribute("aPosA", new THREE.InterleavedBufferAttribute(buf, 3, IA_POS));
  geometry.setAttribute("aNrmA", new THREE.InterleavedBufferAttribute(buf, 3, IA_NRM));
  geometry.setAttribute("aRadA", new THREE.InterleavedBufferAttribute(buf, 1, IA_RAD));
  geometry.setAttribute("aPosB", new THREE.InterleavedBufferAttribute(buf, 3, IB_POS));
  geometry.setAttribute("aNrmB", new THREE.InterleavedBufferAttribute(buf, 3, IB_NRM));
  geometry.setAttribute("aRadB", new THREE.InterleavedBufferAttribute(buf, 1, IB_RAD));

  geometry.instanceCount = batch.instancesLaid;
  // La esfera envolvente se calcula por lote en el culling; dejar que three la
  // recalcule recorriendo las instancias costaria mas que el propio dibujado.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  return { geometry, revision: batch.revision, source: batch.data };
};

/**
 * Pone la geometria al dia con el lote.
 *
 * Devuelve `true` si hubo que rehacerla entera: el lote crece duplicando su array,
 * y entonces las vistas intercaladas apuntan a la memoria vieja.
 */
export const syncRibbonGeometry = (ribbon: RibbonGeometry, batch: StrokeBatch): boolean => {
  if (ribbon.source !== batch.data) return true;
  if (ribbon.revision === batch.revision) return false;

  // Ahora hay un unico buffer, asi que basta con marcarlo una vez. Antes habia
  // dos vistas sobre el mismo array -y por tanto dos buffers distintos en la GPU-
  // y marcar solo uno dejaba el otro congelado.
  const attr = ribbon.geometry.getAttribute("aPosA") as THREE.InterleavedBufferAttribute | undefined;
  if (attr?.data) attr.data.needsUpdate = true;
  ribbon.geometry.instanceCount = batch.instancesLaid;
  ribbon.revision = batch.revision;
  return false;
};

export const disposeRibbon = (ribbon: RibbonGeometry): void => {
  ribbon.geometry.dispose();
};

/** Radio medio de un trazo, para estimar su tamano en pantalla. */
export const meanRadius = (stroke: Stroke3D): number => {
  if (stroke.count === 0) return 0;
  let sum = 0;
  for (let i = 0; i < stroke.count; i++) {
    sum += radiusAt(stroke.data, i);
  }
  return sum / stroke.count;
};
