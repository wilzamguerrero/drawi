import "./styles.css";
import "./styles-radial-menu.css";
import "./styles-panels.css";
import { App } from "./ui/app";

const root = document.getElementById("app");
if (!root) throw new Error("Falta el contenedor #app");

const app = new App(root);
app.startStatusPolling();

// Acceso desde la consola para depurar sin exponer nada en produccion.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).drawi = app;
}
