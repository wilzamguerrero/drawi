/**
 * Mallas de las primitivas y su material.
 *
 * three.js ya trae las geometrias -caja, esfera, cilindro...-, asi que aqui lo que
 * se resuelve es lo propio del visor: que el objeto se vea con las MISMAS luces
 * que las cintas y las manchas, y con el mismo orden de pintado sin z-buffer, para
 * que no pelee con el resto de la escena.
 *
 * Una primitiva, a diferencia de un trazo, SI tiene volumen de verdad: su normal
 * sale de la geometria, no de un truco de sombreado. Por eso el shader es mas
 * sencillo que el de la cinta -no finge ser un tubo- pero comparte los uniformes
 * de luz para que un cubo y un trazo del mismo color se lean igual.
 */

import * as THREE from "three";
import {
  DEFAULT_PRIMITIVE_SIZE,
  type Object3D,
  type PrimitiveKind,
  type Transform3D,
} from "../scene3d/objects";
import { lightUniforms } from "./ribbon";

const VERT = /* glsl */ `
precision highp float;

uniform mat4 uViewProjection;
uniform mat4 uModel;
uniform mat3 uNormalMatrix;

varying vec3 vNormal;
varying vec3 vWorld;

void main() {
  vec4 world = uModel * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(uNormalMatrix * normal);
  gl_Position = uViewProjection * world;
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec3 vNormal;
varying vec3 vWorld;

uniform vec3 uColor;
uniform vec3 uCameraPos;
uniform float uOpacity;

#define NUM_LUCES 4
uniform vec4 uLightVec[NUM_LUCES];
uniform vec3 uLightColor[NUM_LUCES];
uniform vec3 uAmbient;

void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uCameraPos - vWorld);
  // Translucida y de dos caras: una primitiva de referencia se mira por dentro
  // tanto como por fuera, asi que la cara de atras tambien se sombrea.
  if (dot(n, view) < 0.0) n = -n;

  vec3 difusa = uAmbient;
  for (int i = 0; i < NUM_LUCES; i++) {
    vec4 lv = uLightVec[i];
    vec3 L = lv.w < 0.5 ? normalize(lv.xyz) : normalize(lv.xyz - vWorld);
    difusa += uLightColor[i] * max(dot(n, L), 0.0);
  }

  gl_FragColor = vec4(uColor * difusa * uOpacity, uOpacity);
}
`;

/**
 * Geometria unitaria de cada primitiva, centrada en el origen.
 *
 * Unitaria a proposito: el tamano real lo pone la escala de la transformacion, asi
 * que todas las cajas comparten una geometria y lo unico que cambia es la matriz.
 * El lado base `DEFAULT_PRIMITIVE_SIZE` ya va metido aqui, de modo que una
 * primitiva recien creada con escala 1 tiene un tamano razonable sin tocar nada.
 */
const buildGeometry = (kind: PrimitiveKind): THREE.BufferGeometry => {
  const s = DEFAULT_PRIMITIVE_SIZE;
  switch (kind) {
    case "box":
      return new THREE.BoxGeometry(s, s, s);
    case "sphere":
      return new THREE.SphereGeometry(s * 0.5, 32, 24);
    case "cylinder":
      return new THREE.CylinderGeometry(s * 0.5, s * 0.5, s, 32);
    case "cone":
      return new THREE.ConeGeometry(s * 0.5, s, 32);
    case "plane":
      return new THREE.PlaneGeometry(s, s);
    case "torus":
      return new THREE.TorusGeometry(s * 0.4, s * 0.16, 20, 36);
  }
};

export const createObjectMaterial = (color: string, opacity: number): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uViewProjection: { value: new THREE.Matrix4() },
      uModel: { value: new THREE.Matrix4() },
      uNormalMatrix: { value: new THREE.Matrix3() },
      uColor: { value: new THREE.Color(color) },
      uCameraPos: { value: new THREE.Vector3() },
      ...lightUniforms(),
      uOpacity: { value: opacity },
    },
    transparent: true,
    premultipliedAlpha: true,
    // Las primitivas SI escriben profundidad entre ellas y respetan la del z-buffer
    // local: un objeto solido tiene interior, y sin esto una cara de atras se
    // pintaria sobre una de delante. El plano de los trazos sigue sin z-buffer; los
    // objetos se dibujan antes, asi que el trazo cae encima igual.
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });

/** Compone la matriz de modelo de una transformacion (TRS, euler XYZ). */
export const composeMatrix = (t: Transform3D, out = new THREE.Matrix4()): THREE.Matrix4 => {
  const pos = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(t.rotation.x, t.rotation.y, t.rotation.z, "XYZ"),
  );
  const scl = new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z);
  return out.compose(pos, quat, scl);
};

export interface ObjectEntry {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  kind: PrimitiveKind;
  /** Firma del objeto ya subido, para no rehacer nada si no cambio. */
  revision: string;
}

/** Firma que resume lo que, si cambia, obliga a actualizar la malla. */
export const objectRevision = (o: Object3D): string => {
  const t = o.transform;
  return [
    o.kind,
    o.color,
    o.opacity,
    o.hidden ? 1 : 0,
    t.position.x, t.position.y, t.position.z,
    t.rotation.x, t.rotation.y, t.rotation.z,
    t.scale.x, t.scale.y, t.scale.z,
  ].join(",");
};

export const createObjectEntry = (o: Object3D): ObjectEntry => {
  const geometry = buildGeometry(o.kind);
  const material = createObjectMaterial(o.color, o.opacity);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  applyObject(mesh, material, o);
  return { mesh, geometry, material, kind: o.kind, revision: objectRevision(o) };
};

/** Pone al dia la malla con el objeto (matriz, color, opacidad, visibilidad). */
export const applyObject = (
  mesh: THREE.Mesh,
  material: THREE.ShaderMaterial,
  o: Object3D,
): void => {
  composeMatrix(o.transform, mesh.matrix);
  (material.uniforms.uModel.value as THREE.Matrix4).copy(mesh.matrix);
  // La matriz de normales es la inversa traspuesta de la parte 3x3: sin ella, una
  // escala no uniforme torceria las normales y el sombreado saldria mal.
  (material.uniforms.uNormalMatrix.value as THREE.Matrix3).getNormalMatrix(mesh.matrix);
  (material.uniforms.uColor.value as THREE.Color).set(o.color);
  material.uniforms.uOpacity.value = o.opacity;
  mesh.visible = !o.hidden;
};

export const disposeObjectEntry = (entry: ObjectEntry): void => {
  entry.geometry.dispose();
  entry.material.dispose();
};

/**
 * Material de la sombra de contacto: un disco oscuro con el borde difuminado.
 *
 * El disco es un quad unitario -de -1 a 1 en XY-; el shader lo convierte en una
 * elipse suave con la distancia al centro. No se ilumina ni escribe profundidad
 * -es una mancha en el suelo-, y su borde se desvanece para que no parezca un
 * recorte. Es lo que hace que la sombra se lea como contacto y no como una
 * pegatina negra. El quad se coloca, se escala y se gira sobre el suelo con la
 * matriz de modelo, que calcula el backend a partir del `ShadowDisc`.
 *
 * `uHardness` gradua el borde: el radio al que empieza a caer el alfa. A 0 el
 * disco se desvanece casi desde el centro -muy difuso-; cerca de 1 el nucleo
 * opaco llega casi hasta el borde y la caida es corta -sombra dura-. Es el control
 * que faltaba, el que decide si la sombra es blanda o marcada.
 */
const SHADOW_VERT = /* glsl */ `
precision highp float;
uniform mat4 uViewProjection;
uniform mat4 uModel;
varying vec2 vUv;
void main() {
  // El quad base va de -1 a 1 en XY; se usa como coordenada radial.
  vUv = position.xy;
  gl_Position = uViewProjection * uModel * vec4(position, 1.0);
}
`;

const SHADOW_FRAG = /* glsl */ `
precision highp float;
uniform float uOpacity;
uniform float uHardness;
varying vec2 vUv;
void main() {
  // Distancia al centro del disco (0 dentro, 1 en el borde). El alfa es pleno
  // hasta inner y cae hasta el borde; inner sube con la dureza, asi que un valor
  // alto deja un nucleo opaco grande y una orilla fina -sombra dura-, y uno bajo
  // difumina casi desde el centro -sombra blanda-.
  float r = length(vUv);
  float inner = mix(0.0, 0.92, clamp(uHardness, 0.0, 1.0));
  float a = (1.0 - smoothstep(inner, 1.0, r)) * uOpacity;
  if (a <= 0.002) discard;
  // Negro premultiplicado: rgb ya viene multiplicado por el alfa (rgb = 0), asi
  // que la mezcla premultiplicada oscurece el suelo sin aclarar de rebote.
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

export const createShadowMaterial = (opacity: number, hardness: number): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    uniforms: {
      uViewProjection: { value: new THREE.Matrix4() },
      uModel: { value: new THREE.Matrix4() },
      uOpacity: { value: opacity },
      uHardness: { value: hardness },
    },
    transparent: true,
    premultipliedAlpha: true,
    // Sin z-buffer y sin escribirlo: la sombra vive en el plano del suelo, con el
    // resto de lo coplanar. El orden de pintado la pone debajo de todo.
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

/**
 * Entrada de sombra: el disco de contacto bajo un objeto.
 *
 * Todas las sombras comparten UN quad -el disco base de -1 a 1-, asi que una
 * sombra cuesta una malla mas, no una geometria mas. Lo unico propio por sombra es
 * su material, que lleva su matriz de colocacion y su opacidad.
 */
export interface ShadowEntry {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

/** El quad del disco de sombra: de -1 a 1 en XY. Lo tumba al suelo la matriz. */
export const shadowQuadGeometry = (): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]),
      3,
    ),
  );
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  return g;
};

/**
 * Monta la sombra de un objeto sobre la geometria del disco compartido.
 *
 * Descartar por frustum se apaga: el disco se coloca y escala con la matriz, y la
 * esfera envolvente de la geometria base -radio 2- no describe donde acaba
 * pintando, asi que el descarte de three lo cortaria sin motivo.
 */
export const createShadowEntry = (
  geometry: THREE.BufferGeometry,
  opacity: number,
  hardness: number,
): ShadowEntry => {
  const material = createShadowMaterial(opacity, hardness);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return { mesh, material };
};
