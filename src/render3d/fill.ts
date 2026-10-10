/**
 * Malla y material de las manchas rellenas.
 *
 * Una mancha es una superficie plana, asi que su sombreado es el contrario del de
 * la cinta: aqui la normal es la del plano y no cambia a lo ancho, y lo que hay
 * que resolver es que la mancha se vea igual desde los dos lados. Una cinta se
 * sombrea como un tubo; una mancha, como una lamina de materia.
 *
 * La luz es la misma que la de la cinta -sale de `SCENE_LIGHT`-, porque una
 * escena con dos luces distintas se nota en seguida: un trazo y una mancha del
 * mismo color saldrian de tonos diferentes.
 */

import * as THREE from "three";
import type { FillBatch } from "../scene3d/fill";
import { lightUniforms } from "./ribbon";

const VERT = /* glsl */ `
precision highp float;

attribute vec3 aNormal;

uniform mat4 uViewProjection;

varying vec3 vNormal;
varying vec3 vWorld;

void main() {
  vNormal = aNormal;
  vWorld = position;
  gl_Position = uViewProjection * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec3 vNormal;
varying vec3 vWorld;

uniform vec3 uColor;
uniform vec3 uCameraPos;
uniform float uOpacity;

// Las mismas luces que la cinta, y por el mismo motivo: una mancha y un trazo del
// mismo color tienen que salir del mismo tono.
#define NUM_LUCES 4
uniform vec4 uLightVec[NUM_LUCES];
uniform vec3 uLightColor[NUM_LUCES];
uniform vec3 uAmbient;

void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uCameraPos - vWorld);
  // La mancha se ve por los dos lados: si se mira por detras, la normal util es
  // la contraria. Sin esto, una mancha girada sale en negro.
  if (dot(n, view) < 0.0) n = -n;

  vec3 difusa = uAmbient;
  for (int i = 0; i < NUM_LUCES; i++) {
    vec4 lv = uLightVec[i];
    vec3 L = lv.w < 0.5 ? normalize(lv.xyz) : normalize(lv.xyz - vWorld);
    float wrap = clamp((dot(n, L) + 0.45) / 1.45, 0.0, 1.0);
    difusa += uLightColor[i] * wrap;
  }

  vec3 col = uColor * difusa;
  gl_FragColor = vec4(col * uOpacity, uOpacity);
}
`;

export const createFillMaterial = (color: string, opacity: number): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uViewProjection: { value: new THREE.Matrix4() },
      uColor: { value: new THREE.Color(color) },
      uCameraPos: { value: new THREE.Vector3() },
      ...lightUniforms(),
      uOpacity: { value: opacity },
    },
    transparent: true,
    premultipliedAlpha: true,
    // Las mismas decisiones que la cinta, y por los mismos motivos: los trazos de
    // una sesion son coplanares con su plano de dibujo, asi que el z-buffer daria
    // z-fighting, y el orden de pintado es lo que hace que una mancha se lea como
    // materia puesta encima de otra.
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

export interface FillGeometry {
  geometry: THREE.BufferGeometry;
  revision: number;
  positions: Float32Array;
  normals: Float32Array;
}

/**
 * Enlaza las posiciones y las normales del lote a una geometria.
 *
 * Se hace en una funcion propia porque el bucle de sincronizacion tiene que
 * rehacerla cuando el lote cambia de array -rehacer la malla lo reemplaza-, y las
 * dos ramas tienen que enlazar exactamente igual.
 */
export const bindFills = (geometry: THREE.BufferGeometry, batch: FillBatch): void => {
  geometry.setAttribute("position", new THREE.BufferAttribute(batch.positions, 3));
  geometry.setAttribute("aNormal", new THREE.BufferAttribute(batch.normals, 3));
  geometry.setDrawRange(0, batch.vertices);
  // El culling lo hace la esfera por mancha, no la envolvente del lote; y dejar
  // que three la recalcule recorriendo los vertices costaria mas que el dibujado.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
};

export const createFillGeometry = (batch: FillBatch): FillGeometry => {
  const geometry = new THREE.BufferGeometry();
  bindFills(geometry, batch);
  return { geometry, revision: batch.revision, positions: batch.positions, normals: batch.normals };
};

/** Devuelve `true` si hay que rehacer la geometria: los arrays son otros. */
export const syncFillGeometry = (fill: FillGeometry, batch: FillBatch): boolean => {
  if (fill.positions !== batch.positions || fill.normals !== batch.normals) return true;
  if (fill.revision === batch.revision) return false;
  fill.geometry.setDrawRange(0, batch.vertices);
  const pos = fill.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (pos) pos.needsUpdate = true;
  const nrm = fill.geometry.getAttribute("aNormal") as THREE.BufferAttribute | undefined;
  if (nrm) nrm.needsUpdate = true;
  fill.revision = batch.revision;
  return false;
};
