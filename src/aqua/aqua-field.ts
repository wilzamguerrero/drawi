/**
 * AquaField — motor de acuarela por simulacion de fluidos en WebGL2.
 *
 * Es un solver "Stable Fluids" (advect -> vorticidad -> proyeccion) acoplado a
 * un modelo de pintura humeda: el agua moja el papel y se seca, el pigmento solo
 * fluye donde hay humedad y sangra hacia los bordes. Portado del prototipo
 * `references/inkwash-main` a un modulo aislado y tipado.
 *
 * Fase 1: el motor vive solo (su propio canvas), sin cablear a capas ni paneles.
 * Se alimenta con `splatInk` / `splatWater` / `splatVelocity` (o el ayudante
 * `paint`) y avanza con `step(dt)` + `render()`. La integracion con el documento
 * y la UI llega en fases posteriores.
 *
 * Todo el estado vive en texturas de punto flotante (half-float). Dos rejillas:
 *  - SIM  (velocidad/presion): baja resolucion, basta para el movimiento.
 *  - DYE  (pigmento/humedad): alta resolucion, es lo que se ve.
 */

import {
  ADVECT_INK_FS,
  ADVECT_VEL_FS,
  ADVECT_WET_FS,
  COPY_FS,
  CURL_FS,
  DISPLAY_FS,
  DIVERGENCE_FS,
  EXCHANGE_FS,
  GRAD_SUB_FS,
  PRESSURE_FS,
  SPLAT_FS,
  VERT,
  VORTICITY_FS,
} from "./shaders";

/** Parametros vivos del motor (0..1 salvo nota). Mapean a los sliders del panel. */
export interface AquaParams {
  /** Tamano global del pincel (0.5 = x1; escala 1/3x..3x). */
  size: number;
  /** Energia del fluido: mas flujo = mas movimiento y remolinos. */
  flow: number;
  /** Sangrado del pigmento hacia los bordes (halos). */
  bleed: number;
  /** Secado del papel: alto = se seca rapido. */
  dry: number;
  /** Matiz: tiñe el sangrado de calido a frio (azules/violetas). */
  color: number;
  /** Carga de pigmento del pincel de agua (0 = solo agua). */
  brushInk: number;
}

export const DEFAULT_AQUA_PARAMS: AquaParams = {
  size: 0.5,
  flow: 0.6,
  bleed: 0.5,
  dry: 0.45,
  color: 0.5,
  brushInk: 0.0,
};

/** Modo de huella al pintar. */
export type AquaMode = "pen" | "brush";

/** Absorcion del pigmento base (casi negro, levemente frio). */
const INK_ABS: readonly [number, number, number] = [1.0, 0.97, 0.88];

const SIM_BASE = 256; // rejilla de velocidad/presion
const PRESSURE_ITER = 22; // iteraciones de Jacobi por paso

/** Un programa compilado con sus localizaciones de uniforms cacheadas. */
interface GlProgram {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

/** Un objetivo de render: textura + framebuffer + su texel. */
interface Fbo {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  texel: [number, number];
}

/** Par de FBOs para hacer ping-pong (leer de uno, escribir en el otro). */
interface DoubleFbo {
  w: number;
  h: number;
  texel: [number, number];
  read: Fbo;
  write: Fbo;
  swap(): void;
}

export class AquaField {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private dpr: number;

  readonly params: AquaParams = { ...DEFAULT_AQUA_PARAMS };

  private quadVs: WebGLShader;
  private vao: WebGLVertexArrayObject;

  // Programas (uno por shader del pipeline).
  private pCopy: GlProgram;
  private pSplat: GlProgram;
  private pAdvVel: GlProgram;
  private pAdvWet: GlProgram;
  private pAdvInk: GlProgram;
  private pExch: GlProgram;
  private pDiv: GlProgram;
  private pPressure: GlProgram;
  private pGradSub: GlProgram;
  private pCurl: GlProgram;
  private pVort: GlProgram;
  private pDisplay: GlProgram;

  // Texturas de estado.
  private velocity!: DoubleFbo;
  private pressure!: DoubleFbo;
  private ink!: DoubleFbo;
  private fixed!: DoubleFbo;
  private wet!: DoubleFbo;
  private divergence!: Fbo;
  private curl!: Fbo;

  /** Huella de pincel activa este frame (para el remolino del sangrado). */
  private brushNow = { x: 0, y: 0, r: 0 };
  /** > 0 mientras el pigmento se asienta en el papel (horneado). */
  private fixTimer = 0;
  /** Blanco (gouache) en vez de tinta oscura. */
  private white = false;
  /** Absorcion del pigmento activo (rgb). Deriva del color del pincel. */
  private pigment: [number, number, number] = [INK_ABS[0], INK_ABS[1], INK_ABS[2]];
  /** Segundos de simulacion restantes tras el ultimo deposito (ahorro de GPU). */
  private aliveTimer = 0;
  /** ¿Se ha pintado algo alguna vez? (para no limpiar un canvas ya vacio). */
  private touched = false;

  /** Modo capa: alfa por cobertura para componer sobre la tinta (true en drawi). */
  asLayer = false;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("[aqua] WebGL2 no disponible");
    this.gl = gl;
    gl.getExtension("EXT_color_buffer_float");
    gl.disable(gl.BLEND);

    this.fitCanvas();

    // Vertex shader comun + triangulo a pantalla completa.
    this.quadVs = this.compile(gl.VERTEX_SHADER, VERT);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.pCopy = this.program(COPY_FS);
    this.pSplat = this.program(SPLAT_FS);
    this.pAdvVel = this.program(ADVECT_VEL_FS);
    this.pAdvWet = this.program(ADVECT_WET_FS);
    this.pAdvInk = this.program(ADVECT_INK_FS);
    this.pExch = this.program(EXCHANGE_FS);
    this.pDiv = this.program(DIVERGENCE_FS);
    this.pPressure = this.program(PRESSURE_FS);
    this.pGradSub = this.program(GRAD_SUB_FS);
    this.pCurl = this.program(CURL_FS);
    this.pVort = this.program(VORTICITY_FS);
    this.pDisplay = this.program(DISPLAY_FS);

    this.initTargets();
  }

  // --------------------------------------------------------------- GL plumbing

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`[aqua] shader:\n${log}`);
    }
    return s;
  }

  /** Enlaza el vertex comun con un fragment y cachea las localizaciones de uniforms. */
  private program(fsSrc: string): GlProgram {
    const gl = this.gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.quadVs);
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`[aqua] link:\n${gl.getProgramInfoLog(p)}`);
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (info) uniforms[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { program: p, uniforms };
  }

  /** Dimensiones CSS deseadas; si no se fijan, usa el tamaño del canvas/ventana. */
  private cssW = 0;
  private cssH = 0;

  private fitCanvas(): void {
    const cw = this.cssW || this.canvas.clientWidth || window.innerWidth;
    const ch = this.cssH || this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(2, Math.floor(cw * this.dpr));
    this.canvas.height = Math.max(2, Math.floor(ch * this.dpr));
  }

  private createFbo(w: number, h: number, internal: number, format: number, type: number, filter: number): Fbo {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h, texel: [1 / w, 1 / h] };
  }

  private createDouble(w: number, h: number, internal: number, format: number, type: number, filter: number): DoubleFbo {
    let a = this.createFbo(w, h, internal, format, type, filter);
    let b = this.createFbo(w, h, internal, format, type, filter);
    return {
      w,
      h,
      texel: [1 / w, 1 / h],
      get read() {
        return a;
      },
      get write() {
        return b;
      },
      swap() {
        const t = a;
        a = b;
        b = t;
      },
    };
  }

  /** Resolucion de una rejilla segun el aspecto del canvas. */
  private getRes(base: number): { w: number; h: number } {
    const ar = this.canvas.width / this.canvas.height;
    return ar > 1 ? { w: Math.round(base * ar), h: base } : { w: base, h: Math.round(base / ar) };
  }

  private initTargets(): void {
    const gl = this.gl;
    const HF = gl.HALF_FLOAT;
    const sim = this.getRes(SIM_BASE);
    const dyeBase = Math.min(2048, Math.min(this.canvas.width, this.canvas.height));
    const dye = this.getRes(dyeBase);
    this.velocity = this.createDouble(sim.w, sim.h, gl.RG16F, gl.RG, HF, gl.LINEAR);
    this.divergence = this.createFbo(sim.w, sim.h, gl.R16F, gl.RED, HF, gl.NEAREST);
    this.curl = this.createFbo(sim.w, sim.h, gl.R16F, gl.RED, HF, gl.NEAREST);
    this.pressure = this.createDouble(sim.w, sim.h, gl.R16F, gl.RED, HF, gl.NEAREST);
    this.ink = this.createDouble(dye.w, dye.h, gl.RGBA16F, gl.RGBA, HF, gl.LINEAR);
    this.fixed = this.createDouble(dye.w, dye.h, gl.RGBA16F, gl.RGBA, HF, gl.LINEAR);
    this.wet = this.createDouble(dye.w, dye.h, gl.R16F, gl.RED, HF, gl.LINEAR);
  }

  /** Dibuja el triangulo en un objetivo (o en pantalla si es null). */
  private blit(target: Fbo | null): void {
    const gl = this.gl;
    if (target == null) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.w, target.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Enlaza una textura a una unidad y devuelve el indice de la unidad. */
  private attach(f: Fbo, unit: number): number {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    return unit;
  }

  private copyInto(srcTex: WebGLTexture, dst: Fbo): void {
    const gl = this.gl;
    gl.useProgram(this.pCopy.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this.pCopy.uniforms.uTex, 0);
    gl.uniform1f(this.pCopy.uniforms.uValue, 1.0);
    this.blit(dst);
  }

  // --------------------------------------------------------------- public API

  /**
   * Recalcula el tamaño del canvas y recrea las texturas conservando el estado.
   * Si se pasan dimensiones CSS y dpr, el canvas se dimensiona a ellas (modo
   * integrado en drawi); si no, usa el tamaño del propio canvas/ventana (lab).
   */
  resize(cssW?: number, cssH?: number, dpr?: number): void {
    if (cssW !== undefined && cssH !== undefined) {
      this.cssW = cssW;
      this.cssH = cssH;
    }
    if (dpr !== undefined) this.dpr = Math.min(dpr, 2);
    const old = {
      vel: this.velocity.read.tex,
      ink: this.ink.read.tex,
      fix: this.fixed.read.tex,
      wet: this.wet.read.tex,
    };
    this.fitCanvas();
    this.initTargets();
    this.copyInto(old.vel, this.velocity.write);
    this.velocity.swap();
    this.copyInto(old.ink, this.ink.write);
    this.ink.swap();
    this.copyInto(old.fix, this.fixed.write);
    this.fixed.swap();
    this.copyInto(old.wet, this.wet.write);
    this.wet.swap();
  }

  /** Vacia todo el estado (lienzo en blanco). */
  clear(): void {
    const gl = this.gl;
    for (const d of [this.velocity, this.pressure, this.ink, this.fixed, this.wet]) {
      for (const f of [d.read, d.write]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    this.touched = false;
    this.aliveTimer = 0;
  }

  /** Dispara el horneado: el pigmento movil se asienta en el papel. */
  fix(): void {
    this.fixTimer = 1.2;
    this.aliveTimer = Math.max(this.aliveTimer, 2);
  }

  /**
   * ¿Merece la pena simular/pintar este frame? El fluido sigue vivo un rato tras
   * el ultimo deposito para que termine de fluir y secarse; luego se duerme.
   */
  get active(): boolean {
    return this.aliveTimer > 0;
  }

  /** ¿Hay (o hubo) pintura en el lienzo? */
  get hasContent(): boolean {
    return this.touched;
  }

  /** Mantiene el motor despierto el tiempo indicado (segundos). */
  keepAlive(seconds = 2.5): void {
    this.aliveTimer = Math.max(this.aliveTimer, seconds);
    this.touched = true;
  }

  /** Alterna entre tinta oscura y blanco (gouache). */
  setWhite(on: boolean): void {
    this.white = on;
  }

  /**
   * Fija el pigmento activo desde un color CSS "#rrggbb". El motor pinta por
   * absorcion (exp(-abs)): un color claro absorbe poco, uno oscuro mucho. Se
   * convierte el color a absorcion por canal = 1 - canal_normalizado, con un
   * minimo para que los colores muy claros aun dejen marca.
   */
  setPigment(hex: string): void {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    // Absorcion: canal que falta para el blanco. Se realza un poco para que el
    // pigmento tiña con fuerza como una acuarela saturada.
    this.pigment = [
      Math.min(1.4, (1 - r) * 1.1 + 0.02),
      Math.min(1.4, (1 - g) * 1.1 + 0.02),
      Math.min(1.4, (1 - b) * 1.1 + 0.02),
    ];
  }

  // ------------------------------------------------------------------- splats

  /**
   * Deposita una huella gaussiana en una textura (coordenadas 0..1).
   * `useMax` compone con MAX (para humedad), si no suma (ONE, ONE).
   */
  private splat(target: DoubleFbo, x: number, y: number, r: number, c: readonly number[], useMax: boolean): void {
    const gl = this.gl;
    const f = target.read;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    gl.viewport(0, 0, f.w, f.h);
    // Recorte: solo redibuja el cuadrado afectado por la gaussiana (rendimiento).
    const ex = Math.ceil(r * 4.5 * f.h) + 2;
    const cx = Math.round(x * f.w);
    const cy = Math.round(y * f.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.max(cx - ex, 0), Math.max(cy - ex, 0), ex * 2, ex * 2);
    gl.enable(gl.BLEND);
    if (useMax) gl.blendEquation(gl.MAX);
    else {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
    }
    gl.useProgram(this.pSplat.program);
    gl.uniform1f(this.pSplat.uniforms.uAspect, this.canvas.width / this.canvas.height);
    gl.uniform2f(this.pSplat.uniforms.uPoint, x, y);
    gl.uniform4f(this.pSplat.uniforms.uColor, c[0], c[1], c[2], c[3]);
    gl.uniform1f(this.pSplat.uniforms.uRadius, r * r);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Color de pigmento a depositar segun densidad (oscuro o blanco). */
  private inkColor(dens: number): [number, number, number, number] {
    return this.white
      ? [0, 0, 0, dens]
      : [this.pigment[0] * dens, this.pigment[1] * dens, this.pigment[2] * dens, 0];
  }

  /** Deposita pigmento en (x,y) 0..1 con radio y densidad dados. */
  splatInk(x: number, y: number, r: number, dens: number): void {
    this.splat(this.ink, x, y, r, this.inkColor(dens), false);
    this.keepAlive();
  }

  /** Moja el papel en (x,y) 0..1 (compone con MAX). */
  splatWater(x: number, y: number, r: number, amount: number): void {
    this.splat(this.wet, x, y, r, [amount, 0, 0, 0], true);
    this.keepAlive();
  }

  /** Inyecta velocidad en (x,y) 0..1. */
  splatVelocity(x: number, y: number, r: number, vx: number, vy: number): void {
    this.splat(this.velocity, x, y, r, [vx, vy, 0, 0], false);
    this.keepAlive();
  }

  /** Fija la huella de pincel de este frame (centro y radio para el sangrado). */
  setBrushFootprint(x: number, y: number, r: number): void {
    this.brushNow.x = x;
    this.brushNow.y = y;
    this.brushNow.r = r;
  }

  /**
   * Estampa un TRAZO como acuarela: siembra splats gaussianos solapados a lo
   * largo de la linea central, con el radio real de cada punto. Es el puente
   * desde la geometria del pincel vectorial (ya resuelta con toda su dinamica de
   * presion y afilado) hacia el fluido: el trazo se siente igual que el pincel
   * normal, pero el resultado es humedo y fluye.
   *
   * @param pts  puntos de la linea central en UV: {x,y en 0..1 (Y arriba), r en
   *             unidades Y-normalizadas (como el radio del splat)}.
   * @param dens densidad de pigmento (0 = solo agua, para el modo "Agua").
   */
  stampStroke(pts: readonly { x: number; y: number; r: number }[], dens: number): void {
    if (pts.length === 0) return;
    const wet = this.white ? 0.45 : 0.5;
    let prev = pts[0];
    this.depositDab(prev.x, prev.y, prev.r, dens, wet);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const dist = Math.hypot(dx, dy);
      // Espaciado denso (fraccion del radio) para que los dabs se solapen y la
      // linea salga continua, no como perlas sueltas.
      const r = Math.max(p.r, 0.002);
      const spacing = r * 0.18;
      const steps = Math.min(Math.ceil(dist / spacing), 260);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const x = prev.x + dx * t;
        const y = prev.y + dy * t;
        const rr = prev.r + (p.r - prev.r) * t;
        this.depositDab(x, y, Math.max(rr, 0.002), dens, wet);
      }
      prev = p;
    }
    this.keepAlive(3);
  }

  /**
   * Estampa un AREA rellena (relleno/forma) como acuarela: rasteriza el poligono
   * con una rejilla densa de dabs solapados para que la mancha sea uniforme.
   */
  stampArea(poly: readonly { x: number; y: number }[], dens: number): void {
    if (poly.length < 3) return;
    let minx = 1;
    let miny = 1;
    let maxx = 0;
    let maxy = 0;
    for (const p of poly) {
      if (p.x < minx) minx = p.x;
      if (p.y < miny) miny = p.y;
      if (p.x > maxx) maxx = p.x;
      if (p.y > maxy) maxy = p.y;
    }
    minx = Math.max(0, minx);
    miny = Math.max(0, miny);
    maxx = Math.min(1, maxx);
    maxy = Math.min(1, maxy);
    const bw = maxx - minx;
    const bh = maxy - miny;
    if (bw <= 0 || bh <= 0) return;
    const wet = this.white ? 0.45 : 0.5;
    // Rejilla fina y solapada (paso pequeño, dab mayor que el paso).
    const step = Math.max(0.0035, Math.min(bw, bh) / 26);
    const r = step * 1.6;
    for (let y = miny; y <= maxy; y += step) {
      for (let x = minx; x <= maxx; x += step) {
        if (!pointInPoly(x, y, poly)) continue;
        this.depositDab(x, y, r, dens, wet);
      }
    }
    this.keepAlive(3);
  }

  /**
   * Deposita un dab de acuarela: pigmento (si dens>0), humedad para que fluya y
   * una pizca de velocidad radial que empuja la tinta hacia afuera (asi el agua
   * de verdad arrastra el pigmento existente, no solo lo moja).
   */
  private depositDab(x: number, y: number, r: number, dens: number, wet: number): void {
    if (dens > 0) this.splat(this.ink, x, y, r, this.inkColor(dens), false);
    this.splat(this.wet, x, y, r * 2.0, [wet, 0, 0, 0], true);
    // Empuje radial pequeño: da vida al borde (halos) y hace que el modo Agua
    // mueva de verdad el pigmento ya depositado.
    const push = (12 + this.params.flow * 40) * (dens > 0 ? 0.4 : 1.0);
    const a = Math.random() * Math.PI * 2;
    this.splat(this.velocity, x, y, r * 1.2, [Math.cos(a) * push, Math.sin(a) * push, 0, 0], false);
    this.keepAlive(3);
  }

  // --------------------------------------------------------------------- step

  /** Avanza la simulacion un paso de tiempo `dt` (segundos). */
  step(dt: number): void {
    if (this.aliveTimer > 0) this.aliveTimer -= dt;
    const gl = this.gl;
    const P = this.params;
    const fixing = this.fixTimer > 0;
    if (fixing) this.fixTimer -= dt;
    const aspect = this.canvas.width / this.canvas.height;

    // Velocidad: adveccion + amortiguacion, confinada al papel mojado.
    gl.useProgram(this.pAdvVel.program);
    gl.uniform1i(this.pAdvVel.uniforms.uVelocity, this.attach(this.velocity.read, 0));
    gl.uniform1i(this.pAdvVel.uniforms.uWet, this.attach(this.wet.read, 1));
    gl.uniform2f(this.pAdvVel.uniforms.uTexel, this.velocity.texel[0], this.velocity.texel[1]);
    gl.uniform1f(this.pAdvVel.uniforms.uDt, dt);
    gl.uniform1f(
      this.pAdvVel.uniforms.uDissipation,
      Math.exp(-dt * (3.0 - P.flow * 2.4)) * (fixing ? Math.exp(-dt * 7) : 1),
    );
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Vorticidad: curl y reinyeccion de remolinos.
    gl.useProgram(this.pCurl.program);
    gl.uniform1i(this.pCurl.uniforms.uVelocity, this.attach(this.velocity.read, 0));
    gl.uniform2f(this.pCurl.uniforms.uTexel, this.velocity.texel[0], this.velocity.texel[1]);
    this.blit(this.curl);

    gl.useProgram(this.pVort.program);
    gl.uniform1i(this.pVort.uniforms.uVelocity, this.attach(this.velocity.read, 0));
    gl.uniform1i(this.pVort.uniforms.uCurl, this.attach(this.curl, 1));
    gl.uniform2f(this.pVort.uniforms.uTexel, this.velocity.texel[0], this.velocity.texel[1]);
    gl.uniform1f(this.pVort.uniforms.uCurlAmt, 4 + P.flow * 22);
    gl.uniform1f(this.pVort.uniforms.uDt, dt);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Proyeccion: divergencia -> presion (Jacobi) -> resta de gradiente.
    gl.useProgram(this.pDiv.program);
    gl.uniform1i(this.pDiv.uniforms.uVelocity, this.attach(this.velocity.read, 0));
    gl.uniform2f(this.pDiv.uniforms.uTexel, this.velocity.texel[0], this.velocity.texel[1]);
    this.blit(this.divergence);

    gl.useProgram(this.pCopy.program);
    gl.uniform1i(this.pCopy.uniforms.uTex, this.attach(this.pressure.read, 0));
    gl.uniform1f(this.pCopy.uniforms.uValue, 0.8);
    this.blit(this.pressure.write);
    this.pressure.swap();

    gl.useProgram(this.pPressure.program);
    gl.uniform1i(this.pPressure.uniforms.uDivergence, this.attach(this.divergence, 1));
    gl.uniform2f(this.pPressure.uniforms.uTexel, this.velocity.texel[0], this.velocity.texel[1]);
    for (let i = 0; i < PRESSURE_ITER; i++) {
      gl.uniform1i(this.pPressure.uniforms.uPressure, this.attach(this.pressure.read, 0));
      this.blit(this.pressure.write);
      this.pressure.swap();
    }

    gl.useProgram(this.pGradSub.program);
    gl.uniform1i(this.pGradSub.uniforms.uPressure, this.attach(this.pressure.read, 0));
    gl.uniform1i(this.pGradSub.uniforms.uVelocity, this.attach(this.velocity.read, 1));
    gl.uniform2f(this.pGradSub.uniforms.uTexel, this.velocity.texel[0], this.velocity.texel[1]);
    this.blit(this.velocity.write);
    this.velocity.swap();

    // Agua: se seca; DRY fija la escala temporal (secado flash al hornear).
    const dryTau = fixing ? 0.25 : 2 + (1 - P.dry) * 16;
    gl.useProgram(this.pAdvWet.program);
    gl.uniform1i(this.pAdvWet.uniforms.uVelocity, this.attach(this.velocity.read, 0));
    gl.uniform1i(this.pAdvWet.uniforms.uWet, this.attach(this.wet.read, 1));
    gl.uniform2f(this.pAdvWet.uniforms.uTexel, this.velocity.texel[0], this.velocity.texel[1]);
    gl.uniform2f(this.pAdvWet.uniforms.uSrcTexel, this.wet.texel[0], this.wet.texel[1]);
    gl.uniform1f(this.pAdvWet.uniforms.uDt, dt);
    gl.uniform1f(this.pAdvWet.uniforms.uDecay, Math.exp(-dt / dryTau));
    gl.uniform1f(this.pAdvWet.uniforms.uSpread, 0.12);
    this.blit(this.wet.write);
    this.wet.swap();

    // Pigmento: fluye y sangra solo donde hay humedad.
    const C = P.color;
    gl.useProgram(this.pAdvInk.program);
    gl.uniform1i(this.pAdvInk.uniforms.uVelocity, this.attach(this.velocity.read, 0));
    gl.uniform1i(this.pAdvInk.uniforms.uSource, this.attach(this.ink.read, 1));
    gl.uniform1i(this.pAdvInk.uniforms.uWet, this.attach(this.wet.read, 2));
    gl.uniform2f(this.pAdvInk.uniforms.uTexel, this.velocity.texel[0], this.velocity.texel[1]);
    gl.uniform2f(this.pAdvInk.uniforms.uSrcTexel, this.ink.texel[0], this.ink.texel[1]);
    gl.uniform1f(this.pAdvInk.uniforms.uDt, dt);
    gl.uniform1f(this.pAdvInk.uniforms.uBleed, P.bleed);
    gl.uniform1f(this.pAdvInk.uniforms.uAspect, aspect);
    gl.uniform3f(this.pAdvInk.uniforms.uChroma, 1.0 + 0.85 * C, 1.0 + 0.15 * C, Math.max(0.25, 1.0 - 0.65 * C));
    gl.uniform3f(this.pAdvInk.uniforms.uBrush, this.brushNow.x, this.brushNow.y, this.brushNow.r);
    this.blit(this.ink.write);
    this.ink.swap();

    // Intercambio con la capa fija: asienta al hornear, levanta bajo agua.
    const settle = fixing ? 1 - Math.exp(-dt * 5) : 0;
    gl.useProgram(this.pExch.program);
    gl.uniform1i(this.pExch.uniforms.uFixed, this.attach(this.fixed.read, 0));
    gl.uniform1i(this.pExch.uniforms.uInk, this.attach(this.ink.read, 1));
    gl.uniform1i(this.pExch.uniforms.uWet, this.attach(this.wet.read, 2));
    gl.uniform1f(this.pExch.uniforms.uSettle, settle);
    gl.uniform1f(this.pExch.uniforms.uDt, dt);
    gl.uniform1f(this.pExch.uniforms.uAspect, aspect);
    gl.uniform3f(this.pExch.uniforms.uBrush, this.brushNow.x, this.brushNow.y, this.brushNow.r);
    gl.uniform1f(this.pExch.uniforms.uMode, 0);
    this.blit(this.fixed.write);
    gl.uniform1f(this.pExch.uniforms.uMode, 1);
    this.blit(this.ink.write);
    this.fixed.swap();
    this.ink.swap();

    // La huella se consume cada paso: el emisor la vuelve a fijar si sigue pintando.
    this.brushNow.r = 0;
  }

  /** Compone el estado y lo pinta en el canvas visible. */
  render(): void {
    const gl = this.gl;
    if (this.asLayer) {
      // Limpiar a transparente: el display escribe alfa por cobertura y el
      // navegador compone el plano sobre la tinta de drawi.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.useProgram(this.pDisplay.program);
    gl.uniform1i(this.pDisplay.uniforms.uInk, this.attach(this.ink.read, 0));
    gl.uniform1i(this.pDisplay.uniforms.uWet, this.attach(this.wet.read, 1));
    gl.uniform1i(this.pDisplay.uniforms.uFixed, this.attach(this.fixed.read, 2));
    gl.uniform2f(this.pDisplay.uniforms.uTexel, this.ink.texel[0], this.ink.texel[1]);
    gl.uniform2f(this.pDisplay.uniforms.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.pDisplay.uniforms.uInkStrength, 1.9);
    gl.uniform1f(this.pDisplay.uniforms.uEdge, 1.35);
    gl.uniform1f(this.pDisplay.uniforms.uGrain, 0.55);
    gl.uniform1f(this.pDisplay.uniforms.uWhiteTint, this.params.color * 0.35);
    gl.uniform1f(this.pDisplay.uniforms.uAsLayer, this.asLayer ? 1 : 0);
    this.blit(null);
  }
}

/** Test punto-en-poligono (ray casting) en coordenadas UV. */
function pointInPoly(x: number, y: number, poly: readonly { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
