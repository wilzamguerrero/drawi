/**
 * Shaders del motor de acuarela (fluidos en GPU, WebGL2).
 *
 * Es un solver "Stable Fluids" clasico (Stam) adaptado a pintura humeda: el
 * fluido solo se mueve donde el PAPEL esta mojado, el agua se expande y se seca
 * sola, y el pigmento viaja con la corriente sangrando hacia los bordes (los
 * halos frios tipicos de la acuarela). Portado del prototipo `inkwash` a un
 * modulo aislado para integrarlo en el pipeline de drawi.
 *
 * Texturas (todas ping-pong salvo las intermedias de presion):
 *  - velocity (RG16F) : campo de velocidad del fluido.
 *  - divergence/curl  : intermedias del paso de proyeccion / vorticidad.
 *  - pressure (R16F)  : presion (Jacobi, se itera varias veces).
 *  - wet (R16F)       : humedad del papel; sin agua el pigmento no fluye.
 *  - ink (RGBA16F)    : pigmento movil (rgb = absorcion, a = blanco/gouache).
 *  - fixed (RGBA16F)  : pigmento ya secado (horneado) en el papel.
 *
 * Todos comparten el mismo vertex shader de triangulo a pantalla completa.
 */

/** Vertex shader comun: un unico triangulo que cubre el viewport. */
export const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;

/** Copia una textura escalada por un factor (sirve para decaer la presion). */
export const COPY_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform float uValue;
void main(){ o = texture(uTex, vUv) * uValue; }`;

/** Huella gaussiana que se suma (o MAX) directamente en la textura viva. */
export const SPLAT_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform float uAspect; uniform vec2 uPoint;
uniform vec4 uColor; uniform float uRadius;
void main(){
  vec2 p = vUv - uPoint; p.x *= uAspect;
  o = uColor * exp(-dot(p,p) / uRadius);
}`;

/** Velocidad: se autoadvecta, se amortigua y queda confinada al papel mojado. */
export const ADVECT_VEL_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVelocity, uWet;
uniform vec2 uTexel;
uniform float uDt, uDissipation;
void main(){
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  vec2 vel = texture(uVelocity, coord).xy * uDissipation;
  float w = texture(uWet, vUv).x;
  float mask = smoothstep(0.005, 0.2, w);
  o = vec4(vel * mask, 0., 1.);
}`;

/** Agua: la arrastra la corriente, repta hacia afuera y se evapora. */
export const ADVECT_WET_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVelocity, uWet;
uniform vec2 uTexel, uSrcTexel;
uniform float uDt, uDecay, uSpread;
void main(){
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel * 0.6;
  float w = texture(uWet, coord).x;
  vec2 b = uSrcTexel * 1.6;
  float n = (texture(uWet, coord + vec2(b.x, 0.)).x + texture(uWet, coord - vec2(b.x, 0.)).x
           + texture(uWet, coord + vec2(0., b.y)).x + texture(uWet, coord - vec2(0., b.y)).x) * 0.25;
  w = mix(w, n, uSpread);
  o = vec4(w * uDecay, 0., 0., 1.);
}`;

/** Pigmento: movil solo donde hay agua; el sangrado cromatico saca halos. */
export const ADVECT_INK_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVelocity, uSource, uWet;
uniform vec2 uTexel, uSrcTexel;
uniform float uDt, uBleed, uAspect;
uniform vec3 uChroma;
uniform vec3 uBrush;     // x, y, radio (radio <= 0 -> inactivo)
void main(){
  float w = texture(uWet, vUv).x;
  float mob = smoothstep(0.02, 0.45, w);
  vec4 cur = texture(uSource, vUv);
  if (mob < 0.002){ o = cur; return; }
  vec2 vel = texture(uVelocity, vUv).xy;
  vec2 coord = vUv - uDt * vel * uTexel * mob;
  vec4 adv = texture(uSource, coord);
  float brush = 0.;
  if (uBrush.z > 0.){
    vec2 d = vUv - uBrush.xy; d.x *= uAspect;
    brush = exp(-dot(d,d) / (uBrush.z * uBrush.z));
  }
  vec2 b = uSrcTexel * 1.6;
  vec4 n = (texture(uSource, coord + vec2(b.x, 0.)) + texture(uSource, coord - vec2(b.x, 0.))
          + texture(uSource, coord + vec2(0., b.y)) + texture(uSource, coord - vec2(0., b.y))) * 0.25;
  vec4 bleedAmt = clamp(uBleed * (0.25 + 1.3 * brush) * mob * vec4(uChroma, 1.05), 0., 0.92);
  vec4 mixed = mix(adv, n, bleedAmt);
  o = mix(cur, mixed, mob);
}`;

/** Divergencia del campo de velocidad (primer paso de la proyeccion). */
export const DIVERGENCE_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVelocity; uniform vec2 uTexel;
void main(){
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.)).x;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.)).x;
  float B = texture(uVelocity, vUv - vec2(0., uTexel.y)).y;
  float T = texture(uVelocity, vUv + vec2(0., uTexel.y)).y;
  o = vec4(0.5 * (R - L + T - B), 0., 0., 1.);
}`;

/** Una iteracion de Jacobi para resolver la presion. */
export const PRESSURE_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uPressure, uDivergence; uniform vec2 uTexel;
void main(){
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.)).x;
  float B = texture(uPressure, vUv - vec2(0., uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0., uTexel.y)).x;
  float div = texture(uDivergence, vUv).x;
  o = vec4((L + R + B + T - div) * 0.25, 0., 0., 1.);
}`;

/** Resta el gradiente de presion: deja la velocidad sin divergencia. */
export const GRAD_SUB_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uPressure, uVelocity; uniform vec2 uTexel;
void main(){
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.)).x;
  float B = texture(uPressure, vUv - vec2(0., uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0., uTexel.y)).x;
  vec2 vel = texture(uVelocity, vUv).xy - 0.5 * vec2(R - L, T - B);
  o = vec4(vel, 0., 1.);
}`;

/** Rotacional (curl) del campo de velocidad. */
export const CURL_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVelocity; uniform vec2 uTexel;
void main(){
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.)).y;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.)).y;
  float B = texture(uVelocity, vUv - vec2(0., uTexel.y)).x;
  float T = texture(uVelocity, vUv + vec2(0., uTexel.y)).x;
  o = vec4(0.5 * ((R - L) - (T - B)), 0., 0., 1.);
}`;

/** Confinamiento de vorticidad: reinyecta los remolinos que el solver disipa. */
export const VORTICITY_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uVelocity, uCurl;
uniform vec2 uTexel; uniform float uCurlAmt, uDt;
void main(){
  float L = texture(uCurl, vUv - vec2(uTexel.x, 0.)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x, 0.)).x;
  float B = texture(uCurl, vUv - vec2(0., uTexel.y)).x;
  float T = texture(uCurl, vUv + vec2(0., uTexel.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  force *= uCurlAmt * C * vec2(1., -1.);
  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  o = vec4(clamp(vel, -1000., 1000.), 0., 1.);
}`;

/**
 * Intercambio entre el pigmento movil y el seco (horneado): al fijar, el
 * pigmento movil se asienta en la capa fija; el agua puede levantarlo de vuelta
 * (deshabilitado por defecto porque haloneaba trazos nuevos sobre lo seco).
 */
export const EXCHANGE_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uFixed, uInk, uWet;
uniform float uSettle, uDt, uAspect, uMode;
uniform vec3 uBrush;
void main(){
  vec4 F = texture(uFixed, vUv);
  vec4 M = texture(uInk, vUv);
  float w = clamp(texture(uWet, vUv).x, 0., 1.);
  float brush = 0.;
  if (uBrush.z > 0.){
    vec2 d = vUv - uBrush.xy; d.x *= uAspect;
    brush = exp(-dot(d,d) / (uBrush.z * uBrush.z));
  }
  // Levantamiento al remojar: desactivado (haloneaba trazos frescos sobre lo
  // seco y desaturaba pinturas multicapa). Restaurar la linea para reactivarlo.
  // float lift = clamp(w * (0.04 + 0.35 * brush) * uDt, 0., 0.25);
  float lift = 0.0;
  if (uMode < 0.5){
    vec3 fd = F.rgb * (1.0 - lift) + M.rgb * uSettle;
    float fw = F.a * (1.0 - lift) + M.a * uSettle;
    if (uSettle > 0.0){
      // Al hornear: el blanco blanquea el pigmento debajo y pasa a ser papel,
      // asi se puede dibujar oscuro encima despues.
      float c = (1.0 - exp(-2.2 * fw)) * uSettle;
      vec3 T = exp(-fd);
      fd = -log(clamp(T * (1.0 - c) + c, 1e-4, 1.0));
      fw *= 1.0 - uSettle;
    }
    o = vec4(fd, fw);
  } else {
    o = M * (1.0 - uSettle) + F * lift;
  }
}`;

/**
 * Composicion final: absorcion tipo acuarela (exp(-absorcion)) sobre un papel
 * con grano/fibra por ruido fbm, realce de bordes (donde el pigmento se acumula)
 * y oscurecimiento del papel mojado. Devuelve color opaco listo para pantalla.
 */
export const DISPLAY_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uInk, uFixed, uWet;
uniform vec2 uTexel, uRes;
uniform float uInkStrength, uEdge, uGrain, uWhiteTint, uAsLayer;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3. - 2.*f);
  float a = hash(i), b = hash(i + vec2(1., 0.)), c = hash(i + vec2(0., 1.)), d = hash(i + vec2(1., 1.));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){ float v = 0., a = 0.5; for (int i = 0; i < 4; i++){ v += a * vnoise(p); p *= 2.07; a *= 0.5; } return v; }
vec4 pig(vec2 uv){ return texture(uInk, uv) + texture(uFixed, uv); }
void main(){
  vec4 pw = pig(vUv);
  vec3 p = pw.rgb;
  float c = dot(p, vec3(1.));
  float l = dot(pig(vUv - vec2(uTexel.x, 0.)).rgb, vec3(1.));
  float r = dot(pig(vUv + vec2(uTexel.x, 0.)).rgb, vec3(1.));
  float b = dot(pig(vUv - vec2(0., uTexel.y)).rgb, vec3(1.));
  float t = dot(pig(vUv + vec2(0., uTexel.y)).rgb, vec3(1.));
  float edge = length(vec2(r - l, t - b));
  vec2 px = vUv * uRes;
  float fiber = fbm(px * 0.055);
  float tooth = vnoise(px * 0.42);
  float grain = fbm(px * 0.12 + 31.7);
  vec3 paper = vec3(0.962, 0.954, 0.930);
  paper -= (fiber - 0.5) * 0.05;
  paper -= (tooth - 0.5) * 0.022;
  vec3 absb = p * uInkStrength;
  absb *= 1.0 + (grain - 0.5) * uGrain * clamp(c * 2.0, 0., 1.);
  absb *= 1.0 + edge * uEdge;
  vec3 col = paper * exp(-absb);
  // La capa de blanco (gouache) se posa encima de todo lo que tiene debajo.
  float cov = 1.0 - exp(-pw.a * 2.2);
  cov = clamp(cov * (1.0 - (grain - 0.5) * 0.35), 0., 1.);
  vec3 wcol = mix(vec3(0.985, 0.982, 0.972), vec3(0.945, 0.955, 1.0), uWhiteTint);
  col = mix(col, wcol, cov);
  // El papel mojado se oscurece y enfria un poco.
  float wraw = texture(uWet, vUv).x;
  float ws = smoothstep(0.02, 0.6, wraw);
  col *= vec3(1.0) - ws * vec3(0.16, 0.15, 0.11);
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.16;
  // Modo capa: alfa por cobertura (pigmento + blanco + humedad) para que el
  // plano sea transparente donde no se ha pintado y componga sobre la tinta de
  // drawi. Modo lab: opaco (uAsLayer = 0), el papel se ve siempre.
  float paint = clamp(1.0 - exp(-c * uInkStrength * 0.8), 0., 1.);
  float alpha = clamp(max(paint, max(cov, ws * 0.6)), 0., 1.);
  o = vec4(col, mix(1.0, alpha, uAsLayer));
}`;
