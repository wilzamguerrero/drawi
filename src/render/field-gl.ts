import { hexToRgb } from "../core/color";
import { clamp } from "../core/math";
import type { Camera } from "./camera";
import { boundingRadius, SHAPE_CODE, shapeParams, starM } from "../physics/shapes";
import type { Body } from "../physics/world";

export interface FieldStyle {
  /** Radio de fusion global en unidades de mundo. */
  blend: number;
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
  outline: 2,
  outlineColor: "#0d0f14",
  shade: 0.75,
  gloss: 0.35,
  alpha: 1,
  depth: 34,
};

const MAX_BODIES = 512;
const TEXELS = 4;

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
uniform sampler2D uData;

const float PI = 3.141592653589793;

float sdCircle(vec2 p, float r) { return length(p) - r; }

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float sdCapsule(vec2 p, float half, float r) {
  p.x -= clamp(p.x, -half, half);
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

  for (int i = 0; i < ${MAX_BODIES}; i++) {
    if (i >= uCount) break;
    vec4 t0 = texelFetch(uData, ivec2(0, i), 0);
    vec4 t2 = texelFetch(uData, ivec2(2, i), 0);
    vec2 rel = w - t0.xy;
    float kk = t2.y > 0.0 ? t2.y : k;
    float reach = t2.x + kk + 2.0;
    if (dot(rel, rel) > reach * reach) continue;

    vec4 t1 = texelFetch(uData, ivec2(1, i), 0);
    // Rotacion inversa al espacio local del cuerpo.
    vec2 lp = vec2(rel.x * t0.z + rel.y * t0.w, -rel.x * t0.w + rel.y * t0.z);
    float di = shapeSdf(lp, t1);

    vec3 ci = texelFetch(uData, ivec2(3, i), 0).rgb;
    float h = clamp(0.5 + 0.5 * (d - di) / kk, 0.0, 1.0);
    d = mix(d, di, h) - kk * h * (1.0 - h);
    col = mix(col, ci, h);
  }

  if (uCount == 0) { fragColor = vec4(0.0); return; }

  float aa = max(fwidth(d), 1e-4);
  float inside = 1.0 - smoothstep(-aa, aa, d);
  if (inside <= 0.001 && uOutline <= 0.0) { fragColor = vec4(0.0); return; }

  // Normal 2.5D: la pendiente del campo da la ladera, la profundidad da la cupula.
  float depth = clamp(-d / max(uDepth, 1.0), 0.0, 1.0);
  float z = sqrt(max(0.0, 1.0 - (1.0 - depth) * (1.0 - depth)));
  vec2 grad = vec2(dFdx(d), dFdy(d));
  float gl = length(grad);
  vec2 n2 = gl > 1e-6 ? grad / gl : vec2(0.0);
  vec3 nrm = normalize(vec3(n2 * (1.0 - z), z + 0.15));
  vec3 lightDir = normalize(vec3(-0.45, -0.62, 0.72));

  float diff = clamp(dot(nrm, lightDir), 0.0, 1.0);
  float spec = pow(clamp(dot(reflect(-lightDir, nrm), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 24.0);
  float ao = mix(1.0, 0.72, clamp(1.0 - depth * 1.6, 0.0, 1.0));

  vec3 shaded = col * mix(1.0, 0.55 + 0.75 * diff, uShade) * ao;
  shaded += vec3(1.0) * spec * uGloss * uShade;

  float alpha = inside * uAlpha;

  if (uOutline > 0.0) {
    float halfW = uOutline * 0.5;
    float edge = 1.0 - smoothstep(halfW - aa, halfW + aa, abs(d));
    shaded = mix(shaded, uOutlineColor, edge);
    alpha = max(alpha, edge * uAlpha);
  }

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
  private data = new Float32Array(MAX_BODIES * TEXELS * 4);
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private texWidth = 0;
  private texHeight = 0;
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
      "uData",
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

  render(bodies: readonly Body[], camera: Camera, style: FieldStyle, dpr: number): void {
    const gl = this.gl;
    if (!gl || !this.program) return;

    const count = Math.min(bodies.length, MAX_BODIES);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count === 0) return;

    this.uploadBodies(gl, bodies, count);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

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
    gl.uniform1i(u.uData!, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
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
      d[o + 11] = 1;

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
    this.gl = null;
  }
}
