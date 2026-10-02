import { hexToRgb } from "../core/color";
import { clamp } from "../core/math";
import type { Camera } from "./camera";
import { computeBridges } from "../physics/bridges";
import { boundingRadius, SHAPE_CODE, shapeParams, starM } from "../physics/shapes";
import type { Body } from "../physics/world";

/** Forma de los puentes entre cuerpos. */
export type BridgeStyle = "direct" | "torn" | "organic";

export const BRIDGE_STYLE_CODE: Record<BridgeStyle, number> = {
  direct: 0,
  torn: 1,
  organic: 2,
};

export interface FieldStyle {
  /** Radio de fusion global en unidades de mundo. */
  blend: number;
  /** Alcance global de los puentes dirigidos entre cuerpos, en unidades de
   *  mundo. 0 = sin puentes. Cada cuerpo puede sobreescribirlo con su propio
   *  `bridgeReach` (ver `Body`). No atrae los cuerpos: solo los funde. */
  bridgeReach: number;
  /** Forma del puente: recto, desgarrado (discontinuo) u organico (ondula). */
  bridgeStyle: BridgeStyle;
  /** Nº de hilos/tejidos por puente (1 = cuello unico, >1 = haz tipo vena). */
  bridgeThreads: number;
  /** Hasta donde llegan los cortes de los hilos desde la conexion (0..1):
   *  bajo = solo al principio/final y se funden pronto; alto = casi todo. */
  bridgeThreadReach: number;
  /** Ensanche del cuello en los puntos de conexion con los cuerpos (0..1). */
  bridgeFlare: number;
  /** Difuminar la opacidad de los puentes segun el area de alcance (toggle).
   *  Off = puentes solidos y completos como antes. */
  bridgeFade: boolean;
  /** Anima la ondulacion del modo organico (solo GPU). Off = congelada. */
  bridgeAnimate: boolean;
  /** Grosor del contorno en px de pantalla (0 = sin contorno). */
  outline: number;
  outlineColor: string;
  /** Intensidad del sombreado 2.5D. */
  shade: number;
  /** Brillo especular. */
  gloss: number;
  /** Opacidad global de la materia. */
  alpha: number;
  /** Escala del degradado interior; controla el "volumen" aparente. */
  depth: number;
}

export const DEFAULT_FIELD_STYLE: FieldStyle = {
  blend: 26,
  bridgeReach: 0,
  bridgeStyle: "direct",
  bridgeThreads: 1,
  bridgeThreadReach: 0.5,
  bridgeFlare: 0,
  bridgeFade: true,
  bridgeAnimate: true,
  outline: 2,
  outlineColor: "#0d0f14",
  shade: 0.75,
  gloss: 0.35,
  alpha: 1,
  depth: 34,
};

const MAX_BODIES = 512;
const TEXELS = 4;
const MAX_LINKS = 1024;
const LINK_TEXELS = 3;

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform vec2  uResolution;
uniform vec2  uCenter;
uniform float uZoom;
uniform float uRot;
uniform int   uCount;
uniform float uBlend;
uniform float uOutline;
uniform vec3  uOutlineColor;
uniform float uShade;
uniform float uGloss;
uniform float uAlpha;
uniform float uDepth;
uniform float uBridgeReach;
uniform int   uLinkCount;
uniform int   uBridgeStyle;
uniform int   uBridgeThreads;
uniform float uBridgeThreadReach;
uniform float uBridgeFlare;
uniform int   uBridgeFade;
uniform float uTime;
uniform sampler2D uData;
uniform sampler2D uLinks;

const float PI = 3.141592653589793;

float sdCircle(vec2 p, float r) { return length(p) - r; }

/** Distancia a un segmento AB (para el cuello capsular de los puentes). */
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

/**
 * Opacidad de un puente por distancia radial a cada cuerpo: llena dentro del
 * cuerpo, se desvanece a 0 justo en el borde de su area de alcance. Asi el
 * difuminado llega EXACTAMENTE hasta el circulo de alcance, no mas alla.
 * s = (innerA, outerA, innerB, outerB).
 */
float linkSupport(float distA, float distB, vec4 s) {
  float supA = 1.0 - smoothstep(s.x, s.y, distA);
  float supB = 1.0 - smoothstep(s.z, s.w, distB);
  return clamp(max(supA, supB), 0.0, 1.0);
}

/**
 * Distancia con signo de un puente segun su estilo y sus conectores.
 *  style: 0 recto, 1 desgarrado (agujeros), 2 organico (ondula con el tiempo).
 *  uBridgeThreads: talla CORTES finos en el cuello cerca de la conexion, de
 *    modo que la union se vea separada en hebras (no son fibras anadidas).
 *  uBridgeFlare: ensancha el cuello en los extremos (conexion mas gruesa).
 */
float linkField(vec2 p, vec2 a, vec2 b, float r, int style, float phase) {
  vec2 ba = b - a;
  float len = max(length(ba), 1e-4);
  vec2 dir = ba / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 pa = p - a;
  float along = dot(pa, dir);
  float h = clamp(along / len, 0.0, 1.0);
  float perp = dot(pa, nrm);

  float ends = pow(abs(2.0 * h - 1.0), 2.0);
  float rLocal = r * (1.0 + uBridgeFlare * 1.6 * ends);
  float env = 1.0 - ends; // 0 en los extremos, 1 en el centro
  float freq = 6.2831 * (len / 220.0 + 0.5);

  // Cuello principal: capsula unica (opcional ondulacion organica en el centro).
  float neckOff = style == 2 ? r * 1.1 * env * sin(h * freq + uTime * 1.6 + phase) : 0.0;
  float neckD = along < 0.0 ? length(pa) : (along > len ? length(p - b) : abs(perp - neckOff));
  float best = neckD - rLocal;

  // Hilos = CORTES: se tallan ranuras finas paralelas al eje, concentradas en
  // la zona de conexion (fan) y nulas en el centro, para que el cuello se vea
  // partido en hebras justo donde se une a cada cuerpo. Es resta (max con -g).
  int n = uBridgeThreads < 1 ? 1 : uBridgeThreads;
  if (n > 1) {
    float e = abs(2.0 * h - 1.0); // 1 en los extremos, 0 en el centro
    float span = clamp(uBridgeThreadReach, 0.05, 1.0);
    // Banda del corte: siempre pleno en los extremos (e~1); el borde interior
    // sube con el alcance hasta llegar al centro (e~0) cuando span = 1.
    float band = 0.15;
    float hi = min(1.0, (1.0 - span) + band);
    float lo = hi - band;
    float cutProfile = smoothstep(lo, hi, e);
    float cutW = rLocal * 0.14;
    float spread = rLocal * 1.6;
    for (int i = 0; i < 5; i++) {
      if (i >= n - 1) break;
      float o = spread * (float(i + 1) / float(n) - 0.5);
      if (style == 2) o += r * 0.5 * sin(h * freq + uTime * 1.6 + phase + float(i));
      float groove = abs(perp - neckOff - o) - cutW;
      // mix por cutProfile: en 0 NO toca el campo (si no, dejaria una linea fina
      // en toda la longitud del corte aunque el alcance sea minimo).
      best = mix(best, max(best, -groove), cutProfile);
    }
  }

  if (style == 1) {
    // Desgarrado: perfora agujeros irregulares (sin partir el cuello).
    float cell = max(6.0, r * 2.2);
    float idx = floor(along / cell);
    float localc = along - (idx + 0.5) * cell;
    float rnd = fract(sin(idx * 12.9898 + phase * 7.0) * 43758.5453);
    float rnd2 = fract(sin(idx * 78.233 + phase * 3.0) * 24634.6345);
    float holeR = r * (0.3 + 0.45 * rnd);
    float perpOff = (rnd2 - 0.5) * r * 0.9;
    float dh = length(vec2(localc, perp - perpOff)) - holeR;
    best = max(best, -dh);
  }
  return best;
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float sdCapsule(vec2 p, float hlen, float r) {
  p.x -= clamp(p.x, -hlen, hlen);
  return length(p) - r;
}

float sdNgon(vec2 p, float r, float n, float round) {
  float an = PI / n;
  vec2 acs = vec2(cos(an), sin(an));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p.y += clamp(-p.y, 0.0, r * acs.y);
  return length(p) * sign(p.x) - round;
}

float sdStar(vec2 p, float r, float n, float m) {
  float an = PI / n;
  float en = PI / max(2.0001, m);
  vec2 acs = vec2(cos(an), sin(an));
  vec2 ecs = vec2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}

float shapeSdf(vec2 p, vec4 s) {
  int t = int(s.x + 0.5);
  if (t == 0) return sdCircle(p, s.y);
  if (t == 1) return sdRoundBox(p, vec2(s.y, s.z), s.w);
  if (t == 2) return sdCapsule(p, s.z, s.y);
  if (t == 3) return sdNgon(p, s.y, max(3.0, s.z), s.w);
  return sdStar(p, s.y, max(3.0, s.z), s.w);
}

vec2 screenToWorld(vec2 frag) {
  vec2 d = (frag - uResolution * 0.5) / uZoom;
  float c = cos(-uRot);
  float s = sin(-uRot);
  return vec2(d.x * c - d.y * s, d.x * s + d.y * c) + uCenter;
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 w = screenToWorld(frag);

  float d = 1e20;
  vec3 col = vec3(0.0);
  float k = max(uBlend, 0.001);
  float supp = 0.0; // soporte de alfa: 1 solido, 0 difuminado (puentes lejanos)

  // --- Campo base: union suave de cada cuerpo con su propio radio de fusion ---
  for (int i = 0; i < ${MAX_BODIES}; i++) {
    if (i >= uCount) break;
    vec4 t0 = texelFetch(uData, ivec2(0, i), 0);
    vec4 t2 = texelFetch(uData, ivec2(2, i), 0);
    vec2 rel = w - t0.xy;
    float kk = t2.y > 0.0 ? t2.y : k;
    float reach = t2.x + kk + 2.0;
    if (dot(rel, rel) > reach * reach) continue;

    vec4 t1 = texelFetch(uData, ivec2(1, i), 0);
    vec2 lp = vec2(rel.x * t0.z + rel.y * t0.w, -rel.x * t0.w + rel.y * t0.z);
    float di = shapeSdf(lp, t1);
    vec3 ci = texelFetch(uData, ivec2(3, i), 0).rgb;

    float h = clamp(0.5 + 0.5 * (d - di) / kk, 0.0, 1.0);
    d = mix(di, d, 1.0 - h) - kk * h * (1.0 - h);
    col = mix(col, ci, h);
    supp = mix(supp, 1.0, h); // la materia siempre es solida
  }

  // --- Puentes dirigidos: cuellos capsulares precalculados en CPU ---
  // Cada enlace une dos cuerpos concretos a lo largo de la recta entre sus
  // centros, asi el puente nunca sale "hacia todos lados" y el coste escala con
  // el numero real de enlaces (con descarte por distancia al segmento).
  for (int li = 0; li < ${MAX_LINKS}; li++) {
    if (li >= uLinkCount) break;
    vec4 l0 = texelFetch(uLinks, ivec2(0, li), 0); // ax, ay, bx, by
    vec4 l1 = texelFetch(uLinks, ivec2(1, li), 0); // r, k, colorPacked, phase
    // Descarte barato por distancia al segmento recto antes del calculo del
    // estilo (margen amplio para hilos, ondulacion organica y ensanche).
    if (sdSegment(w, l0.xy, l0.zw) > l1.x * 4.0 + l1.y + 4.0) continue;
    float seg = linkField(w, l0.xy, l0.zw, l1.x, uBridgeStyle, l1.w);
    float kL = max(l1.y, 0.001);
    if (seg > kL + 2.0) continue;
    // Desempaquetar color (r*65536 + g*256 + b, enteros 0..255).
    float p = l1.z;
    float rr = floor(p / 65536.0);
    float gg = floor(mod(p, 65536.0) / 256.0);
    float bb = mod(p, 256.0);
    vec3 lc = vec3(rr, gg, bb) / 255.0;
    // Opacidad del puente. uBridgeFade: si esta activo, difumina hasta el borde
    // del area de alcance de cada cuerpo (distancia radial) y ademas atenua el
    // puente entero segun lo cerca que esten los alcances (tenue de lejos, mas
    // opaco al acercarse; sin salto brusco). Si no, el puente es solido.
    vec4 l2 = texelFetch(uLinks, ivec2(2, li), 0); // innerA, outerA, innerB, outerB
    float ls = 1.0;
    if (uBridgeFade == 1) {
      float radial = linkSupport(length(w - l0.xy), length(w - l0.zw), l2);
      float gap = length(l0.zw - l0.xy) - l2.x - l2.z;
      float reachSum = (l2.y - l2.x) + (l2.w - l2.z);
      float prox = clamp(1.0 - smoothstep(0.0, reachSum * 1.5, gap), 0.0, 1.0);
      ls = radial * prox;
    }
    float h = clamp(0.5 + 0.5 * (d - seg) / kL, 0.0, 1.0);
    d = mix(seg, d, 1.0 - h) - kL * h * (1.0 - h);
    col = mix(col, lc, h);
    supp = mix(supp, ls, h);
  }

  if (uCount == 0) { fragColor = vec4(0.0); return; }

  // 1 pixel de dispositivo en unidades de mundo. El campo d esta en mundo, asi
  // que todo umbral en px (contorno, antialias) hay que traerlo a esta escala.
  float px = 1.0 / max(uZoom, 1e-4);
  // fwidth(d) se dispara en las costuras de la fusion suave (el termino -k*h*(1-h)
  // mete un pico de gradiente); si no se acota, el antialias engorda y el contorno
  // sangra en almendras negras. Lo fijamos a ~1px real.
  float aa = clamp(fwidth(d), 0.5 * px, 2.5 * px);
  float inside = 1.0 - smoothstep(-aa, aa, d);
  if (inside <= 0.001 && uOutline <= 0.0) { fragColor = vec4(0.0); return; }

  // Relleno plano del color fusionado, igual que el respaldo CPU: todo el
  // interior del blob es el mismo color, asi que las formas que se funden se
  // leen como una sola silueta. NO se oscurece por grosor de campo: eso pintaba
  // de negro los cuellos y solapes finos (las "almendras"), que es justo lo que
  // rompia la fusion. La unica marca es el contorno fino sobre el cruce por 0.
  vec3 shaded = col;

  float alpha = inside * uAlpha;

  if (uOutline > 0.0) {
    // uOutline viene en px de pantalla; el contorno se mide contra abs(d) que
    // esta en mundo, por eso se convierte con px.
    float halfW = uOutline * 0.5 * px;
    float edge = 1.0 - smoothstep(halfW - aa, halfW + aa, abs(d));
    shaded = mix(shaded, uOutlineColor, edge);
    alpha = max(alpha, edge * uAlpha);
  }

  // El soporte difumina los puentes incompletos (la materia tiene soporte 1).
  alpha *= clamp(supp, 0.0, 1.0);

  fragColor = vec4(shaded * alpha, alpha);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("No se pudo crear el shader");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? "";
    gl.deleteShader(sh);
    throw new Error(`Error compilando shader: ${log}`);
  }
  return sh;
}

/**
 * Renderizador del campo de materia.
 *
 * Un unico quad a pantalla completa evalua la union suave de todos los cuerpos.
 * Los datos viajan en una textura RGBA32F (4 texels por cuerpo) en lugar de en
 * uniformes, para no chocar con el limite de vectores uniformes, y cada pixel
 * descarta por AABB los cuerpos que no le afectan antes de evaluar su SDF.
 */
export class FieldRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly available: boolean;

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private tex: WebGLTexture | null = null;
  private linkTex: WebGLTexture | null = null;
  private data = new Float32Array(MAX_BODIES * TEXELS * 4);
  private linkData = new Float32Array(MAX_LINKS * LINK_TEXELS * 4);
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private texWidth = 0;
  private texHeight = 0;
  private linkTexHeight = 0;
  private lastError: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      // Necesario para que el cuentagotas y la exportacion del viewport puedan
      // leer este canvas con drawImage despues del frame.
      preserveDrawingBuffer: true,
      desynchronized: true,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;

    if (!gl) {
      this.available = false;
      this.lastError = "WebGL2 no disponible";
      console.warn(
        "[drawi] Campo por CPU: getContext('webgl2') devolvió null. " +
          "Probable aceleración por hardware desactivada o GPU en lista de bloqueo (revisa chrome://gpu).",
      );
      return;
    }
    try {
      this.gl = gl;
      this.init(gl);
      this.available = true;
    } catch (err) {
      this.available = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.gl = null;
      console.warn("[drawi] Campo por CPU: falló la inicialización de WebGL2:", this.lastError);
    }
  }

  get error(): string | null {
    return this.lastError;
  }

  private init(gl: WebGL2RenderingContext): void {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!prog) throw new Error("No se pudo crear el programa");
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Error enlazando programa: ${gl.getProgramInfoLog(prog) ?? ""}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = prog;

    const buf = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.linkTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.linkTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    for (const name of [
      "uResolution",
      "uCenter",
      "uZoom",
      "uRot",
      "uCount",
      "uBlend",
      "uOutline",
      "uOutlineColor",
      "uShade",
      "uGloss",
      "uAlpha",
      "uDepth",
      "uBridgeReach",
      "uLinkCount",
      "uBridgeStyle",
      "uBridgeThreads",
      "uBridgeThreadReach",
      "uBridgeFlare",
      "uBridgeFade",
      "uTime",
      "uData",
      "uLinks",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(prog, name);
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  clear(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  render(bodies: readonly Body[], camera: Camera, style: FieldStyle, dpr: number, time = 0): void {
    const gl = this.gl;
    if (!gl || !this.program) return;

    const count = Math.min(bodies.length, MAX_BODIES);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count === 0) return;

    this.uploadBodies(gl, bodies, count);
    const linkCount = this.uploadLinks(gl, bodies, style.bridgeReach);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.linkTex);

    const u = this.uniforms;
    gl.uniform2f(u.uResolution!, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uCenter!, camera.x, camera.y);
    gl.uniform1f(u.uZoom!, camera.zoom * dpr);
    gl.uniform1f(u.uRot!, camera.rotation);
    gl.uniform1i(u.uCount!, count);
    gl.uniform1f(u.uBlend!, Math.max(0.001, style.blend));
    gl.uniform1f(u.uOutline!, style.outline * dpr);
    const oc = hexToRgb(style.outlineColor);
    gl.uniform3f(u.uOutlineColor!, oc.r / 255, oc.g / 255, oc.b / 255);
    gl.uniform1f(u.uShade!, clamp(style.shade, 0, 1));
    gl.uniform1f(u.uGloss!, clamp(style.gloss, 0, 2));
    gl.uniform1f(u.uAlpha!, clamp(style.alpha, 0, 1));
    gl.uniform1f(u.uDepth!, Math.max(1, style.depth));
    gl.uniform1f(u.uBridgeReach!, Math.max(0, style.bridgeReach));
    gl.uniform1i(u.uLinkCount!, linkCount);
    gl.uniform1i(u.uBridgeStyle!, BRIDGE_STYLE_CODE[style.bridgeStyle] ?? 0);
    gl.uniform1i(u.uBridgeThreads!, Math.max(1, Math.round(style.bridgeThreads)));
    gl.uniform1f(u.uBridgeThreadReach!, clamp(style.bridgeThreadReach, 0.05, 1));
    gl.uniform1f(u.uBridgeFlare!, Math.max(0, style.bridgeFlare));
    gl.uniform1i(u.uBridgeFade!, style.bridgeFade ? 1 : 0);
    gl.uniform1f(u.uTime!, time);
    gl.uniform1i(u.uData!, 0);
    gl.uniform1i(u.uLinks!, 1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Precalcula los puentes y los sube a la textura de enlaces. */
  private uploadLinks(gl: WebGL2RenderingContext, bodies: readonly Body[], globalReach: number): number {
    const links = computeBridges(bodies, globalReach);
    const count = Math.min(links.length, MAX_LINKS);
    const d = this.linkData;
    for (let i = 0; i < count; i++) {
      const l = links[i];
      const o = i * LINK_TEXELS * 4;
      d[o] = l.ax;
      d[o + 1] = l.ay;
      d[o + 2] = l.bx;
      d[o + 3] = l.by;
      d[o + 4] = l.r;
      d[o + 5] = l.k;
      d[o + 6] = l.r8 * 65536 + l.g8 * 256 + l.b8;
      d[o + 7] = l.phase;
      d[o + 8] = l.innerA;
      d[o + 9] = l.outerA;
      d[o + 10] = l.innerB;
      d[o + 11] = l.outerB;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.linkTex);
    // Siempre al menos 1 fila para que la textura sea valida aunque no haya enlaces.
    const rows = Math.max(1, count);
    if (this.linkTexHeight !== rows) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, LINK_TEXELS, rows, 0, gl.RGBA, gl.FLOAT, d, 0);
      this.linkTexHeight = rows;
    } else if (count > 0) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LINK_TEXELS, count, gl.RGBA, gl.FLOAT, d, 0);
    }
    return count;
  }

  private uploadBodies(gl: WebGL2RenderingContext, bodies: readonly Body[], count: number): void {
    const d = this.data;
    for (let i = 0; i < count; i++) {
      const b = bodies[i];
      const o = i * TEXELS * 4;
      const cos = Math.cos(b.angle);
      const sin = Math.sin(b.angle);
      d[o] = b.pos.x;
      d[o + 1] = b.pos.y;
      d[o + 2] = cos;
      d[o + 3] = sin;

      const [pa, pb, pc] = shapeParams(b.shape);
      const sides = Math.max(3, Math.round(b.shape.sides));
      d[o + 4] = SHAPE_CODE[b.shape.kind];
      d[o + 5] = pa;
      d[o + 6] = b.shape.kind === "ngon" || b.shape.kind === "star" ? sides : pb;
      d[o + 7] = b.shape.kind === "star" ? starM(sides, b.shape.inner) : pc;

      d[o + 8] = boundingRadius(b.shape);
      d[o + 9] = b.blend;
      d[o + 10] = b.group;
      d[o + 11] = b.bridgeReach;

      const c = hexToRgb(b.color);
      d[o + 12] = c.r / 255;
      d[o + 13] = c.g / 255;
      d[o + 14] = c.b / 255;
      d[o + 15] = 1;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.texWidth !== TEXELS || this.texHeight !== count) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        TEXELS,
        count,
        0,
        gl.RGBA,
        gl.FLOAT,
        d,
        0,
      );
      this.texWidth = TEXELS;
      this.texHeight = count;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXELS, count, gl.RGBA, gl.FLOAT, d, 0);
    }
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.linkTex) gl.deleteTexture(this.linkTex);
    this.gl = null;
  }
}
