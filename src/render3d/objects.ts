/**
 * Mallas de las primitivas y su material PBR.
 *
 * three.js ya trae las geometrias -caja, esfera, cilindro...-, y tambien el
 * material fisico: las primitivas usan `MeshStandardMaterial`, el mismo PBR que el
 * motor de 8th Wall y que el visor de inre. No es un shader propio como la cinta:
 * una primitiva es un solido de verdad, con volumen, y lo que se quiere es que
 * reciba la luz como un objeto real -con rugosidad, metalicidad y sombras-, no el
 * sombreado plano de un trazo.
 *
 * Esto es lo que hace que los objetos proyecten sombra con su FORMA (shadow maps),
 * se ensombrezcan entre si, y respondan a un entorno. Los trazos siguen con su
 * shader propio y su orden de pintor; conviven porque el pase de objetos se dibuja
 * con la camara y las luces nativas de three, y el de trazos despues con su matriz.
 */

import * as THREE from "three";
import {
  DEFAULT_PRIMITIVE_SIZE,
  type Object3D,
  type PrimitiveKind,
  type Transform3D,
} from "../scene3d/objects";

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

/**
 * Material PBR de una primitiva: `MeshStandardMaterial` de three.
 *
 * Es el mismo que usa el motor para su material `basic` -que, pese al nombre, es
 * PBR- y el que inre monta en el visor. three se encarga de la iluminacion fisica
 * (GGX, Fresnel), de leer el mapa de entorno y de recibir y proyectar las sombras;
 * no hay que escribir ni una linea de shader. `transparent` solo cuando hace falta:
 * un material opaco con `transparent: true` paga el orden de transparencia sin
 * motivo y puede pelear con el z-buffer.
 */
export const createObjectMaterial = (o: Object3D): THREE.MeshStandardMaterial => {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(o.color),
    roughness: o.roughness,
    metalness: o.metalness,
    emissive: new THREE.Color(o.emissive),
    emissiveIntensity: o.emissiveIntensity,
    // De dos caras: una primitiva de referencia se mira por dentro tanto como por
    // fuera, y asi un plano o un objeto abierto no desaparece al verlo de canto.
    side: THREE.DoubleSide,
  });
  applyMaterialOpacity(m, o.opacity);
  return m;
};

/** Ajusta la transparencia del material sin dejarlo en modo transparente de balde. */
const applyMaterialOpacity = (m: THREE.MeshStandardMaterial, opacity: number): void => {
  m.opacity = opacity;
  m.transparent = opacity < 0.999;
  // Un material translucido no debe escribir profundidad -taparia lo de detras-,
  // pero uno opaco si, para que las sombras y el z-buffer lo traten como solido.
  m.depthWrite = !m.transparent;
};

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
  material: THREE.MeshStandardMaterial;
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
    o.roughness,
    o.metalness,
    o.emissive,
    o.emissiveIntensity,
    o.hidden ? 1 : 0,
    t.position.x, t.position.y, t.position.z,
    t.rotation.x, t.rotation.y, t.rotation.z,
    t.scale.x, t.scale.y, t.scale.z,
  ].join(",");
};

export const createObjectEntry = (o: Object3D): ObjectEntry => {
  const geometry = buildGeometry(o.kind);
  const material = createObjectMaterial(o);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  // Un objeto solido proyecta y recibe sombra: es lo que hace que un cubo tire su
  // sombra con forma de cubo y que un objeto ensombrezca a otro.
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  applyObject(mesh, material, o);
  return { mesh, geometry, material, kind: o.kind, revision: objectRevision(o) };
};

/** Pone al dia la malla con el objeto (matriz, material, visibilidad). */
export const applyObject = (
  mesh: THREE.Mesh,
  material: THREE.MeshStandardMaterial,
  o: Object3D,
): void => {
  composeMatrix(o.transform, mesh.matrix);
  // El material es nativo de three: necesita la matriz de mundo poblada para que
  // la iluminacion y las sombras usen la posicion y la normal correctas.
  mesh.matrixWorld.copy(mesh.matrix);
  material.color.set(o.color);
  material.roughness = o.roughness;
  material.metalness = o.metalness;
  material.emissive.set(o.emissive);
  material.emissiveIntensity = o.emissiveIntensity;
  applyMaterialOpacity(material, o.opacity);
  mesh.visible = !o.hidden;
};

export const disposeObjectEntry = (entry: ObjectEntry): void => {
  entry.geometry.dispose();
  entry.material.dispose();
};

// Las sombras de los objetos ya no viven aqui: son sombras reales por mapa de
// sombra de three, configuradas en el backend (setupStudio) y recibidas por un
// plano de suelo. No hace falta geometria ni material propios de sombra.

