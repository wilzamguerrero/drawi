import { SOURCE_STRIDE, type FieldSourceBuffer } from '@/field/source'
import type { Camera } from './camera'

/**
 * GPU implicit-surface renderer.
 *
 * Two passes:
 *
 *  1. Accumulate. Each source rasterises only its own bounding quad into a
 *     half-resolution float buffer, adding a smooth falloff. Additive blending
 *     does the fusing for free, and a negative strength subtracts through the
 *     same blend — so "join or carve depending on proximity" needs no branching
 *     and no per-pair work. Cost is proportional to the area sources actually
 *     cover, not to source count squared.
 *
 *  2. Compose. One fullscreen pass thresholds the field at the iso value,
 *     antialiases the edge from the field's own screen-space derivative, and
 *     uses the field gradient as a surface normal to light the result. That
 *     gradient shading is what gives the 2.5D read: flat geometry, volumetric
 *     surface.
 */

const ACCUM_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSeg;
layout(location = 2) in vec4 aParams;

uniform mat3 uView;

out vec2 vDoc;
flat out vec4 vSeg;
flat out vec4 vParams;

void main() {
  vec2 a = aSeg.xy;
  vec2 b = aSeg.zw;
  float reach = max(aParams.x, aParams.y) + aParams.w;
  vec2 center = (a + b) * 0.5;
  vec2 halfExtent = abs(b - a) * 0.5 + vec2(reach);
  vec2 doc = center + aCorner * halfExtent;

  vDoc = doc;
  vSeg = aSeg;
  vParams = aParams;
  gl_Position = vec4((uView * vec3(doc, 1.0)).xy, 0.0, 1.0);
}`

const ACCUM_FRAG = `#version 300 es
precision highp float;

in vec2 vDoc;
flat in vec4 vSeg;
flat in vec4 vParams;

out vec4 outField;

float cro(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }

// Signed distance to a circle swept between two radii (iq).
float sdUnevenCapsule(vec2 p, vec2 pa, vec2 pb, float ra, float rb) {
  p -= pa;
  pb -= pa;
  float h = dot(pb, pb);
  if (h < 1e-8) return length(p) - ra;
  vec2 q = vec2(dot(p, vec2(pb.y, -pb.x)), dot(p, pb)) / h;
  q.x = abs(q.x);
  float bdiff = ra - rb;
  vec2 c = vec2(sqrt(max(h - bdiff * bdiff, 0.0)), bdiff);
  float k = cro(c, q);
  float m = dot(c, q);
  float n = dot(q, q);
  if (k < 0.0) return sqrt(h * n) - ra;
  if (k > c.x) return sqrt(h * (n + 1.0 - 2.0 * q.y)) - rb;
  return m - ra;
}

void main() {
  float d = sdUnevenCapsule(vDoc, vSeg.xy, vSeg.zw, vParams.x, vParams.y);
  float reach = max(vParams.w, 0.001);
  // Wyvill falloff: C2 continuous, so fused surfaces have no visible seam.
  float t = clamp(d / reach, 0.0, 1.0);
  float w = 1.0 - t * t;
  float f = w * w * w * vParams.z;
  outField = vec4(f, 0.0, 0.0, 1.0);
}`

const COMPOSE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = aCorner * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}`

const COMPOSE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uField;
uniform vec2 uTexel;
uniform float uIso;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uShading;
uniform vec2 uLight;
uniform float uRim;

void main() {
  float f = texture(uField, vUv).r;

  // Edge width from the field's own screen-space rate of change: the outline
  // stays exactly one pixel soft at any zoom and any blob size.
  float grad = length(vec2(dFdx(f), dFdy(f)));
  float aa = max(grad, 1e-5) * 1.2;
  float alpha = smoothstep(uIso - aa, uIso + aa, f);
  if (alpha <= 0.001) discard;

  // Central differences give a far more stable normal than derivatives do.
  float fx =
    texture(uField, vUv + vec2(uTexel.x, 0.0)).r -
    texture(uField, vUv - vec2(uTexel.x, 0.0)).r;
  float fy =
    texture(uField, vUv + vec2(0.0, uTexel.y)).r -
    texture(uField, vUv - vec2(0.0, uTexel.y)).r;

  vec3 color = uColor;
  if (uShading > 0.001) {
    vec3 normal = normalize(vec3(-fx, -fy, 0.06));
    vec3 light = normalize(vec3(uLight, 0.85));
    float lambert = clamp(dot(normal, light) * 0.5 + 0.5, 0.0, 1.0);
    // Interior sits above the iso value; the shell is where the gradient lives.
    float depth = clamp((f - uIso) / max(uIso, 0.001), 0.0, 1.0);
    float shade = mix(0.72, 1.28, lambert) * mix(0.92, 1.0, depth);
    color *= mix(1.0, shade, uShading);

    float rim = pow(1.0 - depth, 3.0);
    color += uRim * rim * uShading;
  }

  outColor = vec4(color * uOpacity * alpha, uOpacity * alpha);
}`

export interface FieldStyle {
  color: [number, number, number]
  opacity: number
  /** Iso threshold. Lower values make shapes reach for each other sooner. */
  iso: number
  /** 0 disables gradient lighting and gives a flat graphic fill. */
  shading: number
  light: [number, number]
  rim: number
}

export const defaultFieldStyle = (): FieldStyle => ({
  color: [0.58, 0.78, 1],
  opacity: 1,
  iso: 0.42,
  shading: 0.85,
  light: [-0.45, -0.7],
  rim: 0.16,
})

const compile = (
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader => {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('shader allocation failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`shader compile failed: ${log}`)
  }
  return shader
}

const link = (
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram => {
  const program = gl.createProgram()
  if (!program) throw new Error('program allocation failed')
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`program link failed: ${log}`)
  }
  return program
}

export class FieldRenderer {
  readonly available: boolean
  readonly unsupportedReason: string | null = null

  private readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext | null

  private accum: WebGLProgram | null = null
  private compose: WebGLProgram | null = null
  private quad: WebGLBuffer | null = null
  private instances: WebGLBuffer | null = null
  private accumVao: WebGLVertexArrayObject | null = null
  private composeVao: WebGLVertexArrayObject | null = null
  private fbo: WebGLFramebuffer | null = null
  private fieldTexture: WebGLTexture | null = null

  private instanceCapacity = 0
  private fieldWidth = 0
  private fieldHeight = 0

  /** Field buffer resolution relative to the canvas. Lower is faster. */
  resolutionScale = 0.6

  private readonly view = new Float32Array(9)
  private uniforms: {
    accumView: WebGLUniformLocation | null
    field: WebGLUniformLocation | null
    texel: WebGLUniformLocation | null
    iso: WebGLUniformLocation | null
    color: WebGLUniformLocation | null
    opacity: WebGLUniformLocation | null
    shading: WebGLUniformLocation | null
    light: WebGLUniformLocation | null
    rim: WebGLUniformLocation | null
  } | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
    })
    this.gl = gl

    if (!gl) {
      this.available = false
      this.unsupportedReason = 'WebGL2 is not available in this browser'
      return
    }
    // Float render targets carry the negative values that carving depends on.
    if (!gl.getExtension('EXT_color_buffer_float')) {
      this.available = false
      this.unsupportedReason = 'EXT_color_buffer_float is not supported'
      return
    }

    try {
      this.init(gl)
      this.available = true
    } catch (error) {
      this.available = false
      this.unsupportedReason =
        error instanceof Error ? error.message : 'field renderer init failed'
    }
  }

  private init(gl: WebGL2RenderingContext): void {
    this.accum = link(gl, ACCUM_VERT, ACCUM_FRAG)
    this.compose = link(gl, COMPOSE_VERT, COMPOSE_FRAG)

    this.quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    )

    this.instances = gl.createBuffer()

    this.accumVao = gl.createVertexArray()
    gl.bindVertexArray(this.accumVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances)
    const stride = SOURCE_STRIDE * 4
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16)
    gl.vertexAttribDivisor(2, 1)

    this.composeVao = gl.createVertexArray()
    gl.bindVertexArray(this.composeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    this.fbo = gl.createFramebuffer()

    this.uniforms = {
      accumView: gl.getUniformLocation(this.accum, 'uView'),
      field: gl.getUniformLocation(this.compose, 'uField'),
      texel: gl.getUniformLocation(this.compose, 'uTexel'),
      iso: gl.getUniformLocation(this.compose, 'uIso'),
      color: gl.getUniformLocation(this.compose, 'uColor'),
      opacity: gl.getUniformLocation(this.compose, 'uOpacity'),
      shading: gl.getUniformLocation(this.compose, 'uShading'),
      light: gl.getUniformLocation(this.compose, 'uLight'),
      rim: gl.getUniformLocation(this.compose, 'uRim'),
    }
  }

  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width * dpr))
    const h = Math.max(1, Math.round(height * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.canvas.style.width = `${width}px`
      this.canvas.style.height = `${height}px`
    }
    if (!this.gl || !this.available) return

    const fw = Math.max(1, Math.round(w * this.resolutionScale))
    const fh = Math.max(1, Math.round(h * this.resolutionScale))
    if (fw === this.fieldWidth && fh === this.fieldHeight) return
    this.fieldWidth = fw
    this.fieldHeight = fh
    this.allocateField(this.gl, fw, fh)
  }

  private allocateField(
    gl: WebGL2RenderingContext,
    width: number,
    height: number
  ): void {
    if (this.fieldTexture) gl.deleteTexture(this.fieldTexture)
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      width,
      height,
      0,
      gl.RGBA,
      gl.HALF_FLOAT,
      null
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.fieldTexture = texture

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    )
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Clears the output without running the passes. */
  clear(): void {
    const gl = this.gl
    if (!gl) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  render(
    sources: FieldSourceBuffer,
    camera: Camera,
    style: FieldStyle
  ): void {
    const gl = this.gl
    if (!gl || !this.available || !this.accum || !this.compose || !this.uniforms) {
      return
    }
    if (sources.count === 0) {
      this.clear()
      return
    }

    this.uploadInstances(gl, sources)
    this.writeView(camera)

    // Pass 1 — accumulate into the float field.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, this.fieldWidth, this.fieldHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.ONE, gl.ONE)

    gl.useProgram(this.accum)
    gl.uniformMatrix3fv(this.uniforms.accumView, false, this.view)
    gl.bindVertexArray(this.accumVao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sources.count)

    // Pass 2 — threshold and shade into the visible canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    gl.useProgram(this.compose)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture)
    gl.uniform1i(this.uniforms.field, 0)
    gl.uniform2f(
      this.uniforms.texel,
      1 / this.fieldWidth,
      1 / this.fieldHeight
    )
    gl.uniform1f(this.uniforms.iso, style.iso)
    gl.uniform3f(
      this.uniforms.color,
      style.color[0],
      style.color[1],
      style.color[2]
    )
    gl.uniform1f(this.uniforms.opacity, style.opacity)
    gl.uniform1f(this.uniforms.shading, style.shading)
    gl.uniform2f(this.uniforms.light, style.light[0], style.light[1])
    gl.uniform1f(this.uniforms.rim, style.rim)
    gl.bindVertexArray(this.composeVao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  private uploadInstances(
    gl: WebGL2RenderingContext,
    sources: FieldSourceBuffer
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances)
    const needed = sources.count * SOURCE_STRIDE
    if (needed > this.instanceCapacity) {
      // Overallocate so a growing sketch does not reallocate every frame.
      this.instanceCapacity = Math.max(needed * 2, 4096)
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.instanceCapacity * 4,
        gl.DYNAMIC_DRAW
      )
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sources.view())
  }

  /** Document-to-clip matrix, column major, for the depth-0 plane. */
  private writeView(camera: Camera): void {
    const s = camera.zoom
    const a = (2 * s) / camera.width
    const c = (2 * s) / camera.height
    const v = this.view
    v[0] = a
    v[1] = 0
    v[2] = 0
    v[3] = 0
    v[4] = -c
    v[5] = 0
    v[6] = -a * camera.x
    v[7] = c * camera.y
    v[8] = 1
  }

  dispose(): void {
    const gl = this.gl
    if (!gl) return
    if (this.accum) gl.deleteProgram(this.accum)
    if (this.compose) gl.deleteProgram(this.compose)
    if (this.quad) gl.deleteBuffer(this.quad)
    if (this.instances) gl.deleteBuffer(this.instances)
    if (this.accumVao) gl.deleteVertexArray(this.accumVao)
    if (this.composeVao) gl.deleteVertexArray(this.composeVao)
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    if (this.fieldTexture) gl.deleteTexture(this.fieldTexture)
  }
}
