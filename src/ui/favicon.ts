/* ==========================================================================
   Favicon animado — materia viva en la pestaña del navegador.

   Ni GIF (no anima en Chrome/Edge/Safari) ni SVG (se pinta estático, sin
   CSS/SMIL): la única vía fiable entre navegadores es dibujar a un <canvas>
   fuera de pantalla cada cuadro y volcarlo al <link rel="icon"> con toDataURL.

   Reproduce el mismo lenguaje que el emblema del buscador (.cmd-brand) y el
   núcleo del menú radial: una gota grande "maleable" cuyo borde ondula, con dos
   satélites pequeños que orbitan y derivan a su alrededor. Es la MANCHA NEGRA de
   la materia, así que todo va siempre en el mismo negro, esté la pestaña activa
   o no.

   Sigue latiendo esté visible o no (el usuario lo pidió): por eso el bucle usa
   setInterval —requestAnimationFrame se congela en pestañas de fondo—; el
   navegador ralentiza el temporizador en segundo plano, pero la mancha se mueve.
   Respeta `prefers-reduced-motion`: en ese caso pinta un cuadro estático.
   ========================================================================== */

/** Lienzo interno a 64px: se reduce nítido a 16/32 en la pestaña. */
const SIZE = 64;
/** ~12 fps al frente; en segundo plano el navegador lo ralentiza a su gusto. */
const FRAME_MS = 80;

/** Negro de la materia: la mancha va siempre en este color. */
const INK = "#161619";

/** Un satélite: radio de órbita, tamaño, fase y velocidades propias para que la
    composición respire y no gire en bloque. */
interface Sat {
  orbit: number;
  size: number;
  phase: number;
  speed: number;
  wobble: number;
}

const SATS: Sat[] = [
  { orbit: 21, size: 6.5, phase: 0.4, speed: 0.9, wobble: 1.1 },
  { orbit: 24, size: 4.5, phase: 2.7, speed: -0.62, wobble: 0.8 },
  { orbit: 19, size: 3.5, phase: 4.9, speed: 1.3, wobble: 0.9 },
];

/**
 * Dibuja una gota cerrada: un círculo cuyo radio ondula con varias sinusoides
 * (lóbulos) que giran con el tiempo, igual que el ondulado del borde de materia.
 * Se muestrean N ángulos y se cierra el trazo con una curva suave (quadratics por
 * puntos medios) para que no queden esquinas.
 */
function blobPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, base: number, amp: number, t: number): void {
  const N = 40;
  const pts: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r =
      base +
      amp * Math.sin(3 * a + t * 1.1) +
      amp * 0.5 * Math.sin(5 * a - t * 0.7);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ctx.beginPath();
  const mid = (i: number): [number, number] => {
    const [ax, ay] = pts[i % N];
    const [bx, by] = pts[(i + 1) % N];
    return [(ax + bx) / 2, (ay + by) / 2];
  };
  const [sx, sy] = mid(N - 1);
  ctx.moveTo(sx, sy);
  for (let i = 0; i < N; i++) {
    const [px, py] = pts[i];
    const [mx, my] = mid(i);
    ctx.quadraticCurveTo(px, py, mx, my);
  }
  ctx.closePath();
}

/** Arranca el favicon animado. Devuelve una función para detenerlo (no usada hoy,
    pero deja la puerta abierta a apagarlo). */
export function startFavicon(): () => void {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");

  // Enlace del icono: reutiliza el que haya o crea uno.
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }

  if (!ctx) return () => {};

  // Todo en un solo color: la mancha negra, esté la pestaña activa o no.
  const draw = (t: number): void => {
    ctx.clearRect(0, 0, SIZE, SIZE);
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    ctx.fillStyle = INK;

    for (const s of SATS) {
      const a = s.phase + t * s.speed;
      const ox = cx + Math.cos(a) * s.orbit;
      const oy = cy + Math.sin(a) * s.orbit;
      blobPath(ctx, ox, oy, s.size, s.wobble, t + s.phase);
      ctx.fill();
    }
    blobPath(ctx, cx, cy, 15, 2.4, t);
    ctx.fill();

    link.href = canvas.toDataURL("image/png");
  };

  const now = (): number => performance.now() / 1000;

  // Movimiento reducido: un único cuadro estático, sin bucle.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches) {
    draw(0.6);
    return () => {};
  }

  // setInterval (no requestAnimationFrame): rAF se congela en pestañas de fondo y
  // el usuario quiere que la mancha siga latiendo también ahí. El tiempo base sale
  // de performance.now(), así el movimiento es continuo aunque el navegador
  // ralentice los ticks en segundo plano.
  const timer = window.setInterval(() => draw(now()), FRAME_MS);
  draw(now());

  return () => window.clearInterval(timer);
}
