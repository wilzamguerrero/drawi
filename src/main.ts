import "./styles.css";
import "./styles-fx.css";
import "./styles-radial-menu.css";
import "./styles-panels.css";
import "./styles-side-dock.css";
import "./styles-command.css";
import { App } from "./ui/app";

const root = document.getElementById("app");
if (!root) throw new Error("Falta el contenedor #app");

const app = new App(root);
app.startStatusPolling();

// Retira el splash de arranque (vive en index.html) ahora que el editor esta montado.
// Un respiro minimo para que la materia no parpadee si el bundle llego demasiado rapido.
function dismissSplash(): void {
  const splash = document.getElementById("splash");
  if (!splash) return;
  splash.classList.add("is-gone");
  splash.addEventListener("transitionend", () => splash.remove(), { once: true });
  // Red de seguridad por si no dispara la transicion (movimiento reducido, etc.).
  window.setTimeout(() => splash.remove(), 700);
}

// Le damos tiempo a la secuencia de materia: las gotas se funden (~1.7s) y el logo
// se revela (~0.8s) antes de retirar el splash.
window.setTimeout(dismissSplash, 2800);

// Acceso desde la consola para depurar sin exponer nada en produccion.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).drawi = app;
}
