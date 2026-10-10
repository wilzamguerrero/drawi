import { el } from "./dom";
import { MateriaFx, prefersReducedMotion } from "./fx/materia";

/**
 * Velo de carga.
 *
 * Mientras se abre un archivo la app no atiende: aplicar un proyecto es trabajo
 * sincrono -parsear el JSON, reconstruir capas, rehacer caches-, asi que si el
 * lienzo se queda a la vista, lo que se dibuje encima desaparece en cuanto termina.
 * Este velo tapa la interfaz, se come los clics y avisa de que algo esta pasando.
 *
 * La animacion es la MISMA materia viva del buscador -las gotas de `MateriaFx` que
 * se juntan al aparecer y salen despedidas al irse-, para no inventar un lenguaje
 * nuevo: la masa se forma, se queda respirando mientras se trabaja, y se deshace al
 * terminar.
 */
export class Busy implements Loading {
  readonly el: HTMLElement;

  private fx: MateriaFx;
  private text: HTMLElement;
  private showing = false;
  private clearTimer = 0;

  constructor() {
    this.text = el("p", { class: "busy-text", role: "status", aria: { live: "polite" } });
    this.fx = new MateriaFx({ coreSize: MATTER, reach: 84, dots: 9 });
    // La masa vive dentro de una caja de su propio tamaño: así el texto se coloca
    // debajo con el hueco del flex y no hay que calcular coordenadas de pantalla
    // que se desmontan al cambiar el tamaño de la ventana.
    const matter = el("div", { class: "busy-matter" }, [this.fx.el]);
    this.el = el("div", { class: "busy" }, [matter, this.text]);
  }

  mount(root: HTMLElement): void {
    root.appendChild(this.el);
  }

  get isBusy(): boolean {
    return this.showing;
  }

  /**
   * Muestra el velo y resuelve cuando ya esta PINTADO.
   *
   * Devolver el relevo al navegador es justo el punto: el trabajo que viene despues
   * es sincrono y no suelta el hilo, asi que sin esperar a dos fotogramas el velo
   * apareceria cuando ya no hace falta.
   */
  async begin(label = "Cargando"): Promise<void> {
    window.clearTimeout(this.clearTimer);
    this.text.textContent = label;
    this.showing = true;
    this.el.classList.add("is-visible");
    // El centro va en coordenadas de su caja, no de la pantalla: la masa queda
    // siempre encima del texto, en cualquier tamaño de ventana.
    this.fx.center(MATTER / 2, MATTER / 2);
    if (prefersReducedMotion()) {
      this.fx.clear();
      return;
    }
    this.fx.gather();
    await nextPaint();
  }

  /** Retira el velo. La masa se deshace y el puntero vuelve a mandar enseguida. */
  end(): void {
    if (!this.showing) return;
    this.showing = false;
    this.el.classList.remove("is-visible");
    if (prefersReducedMotion()) {
      this.fx.clear();
      return;
    }
    this.fx.scatter();
    this.clearTimer = window.setTimeout(() => this.fx.clear(), this.fx.scatterMs);
  }

  /** Muestra el velo, hace el trabajo y lo retira. Siempre, aunque el trabajo falle. */
  async run<T>(label: string, work: () => Promise<T> | T): Promise<T> {
    await this.begin(label);
    try {
      return await work();
    } finally {
      this.end();
    }
  }
}

/**
 * Aviso de "estoy trabajando" para quien no es la interfaz.
 *
 * Lo implementa `Busy`, y lo pide la capa de archivos (`file-actions`) para que el
 * velo no aparezca mientras el dialogo nativo esta abierto -ahi manda el sistema y
 * la app no esta haciendo nada- sino justo cuando empieza el trabajo de verdad.
 */
export interface Loading {
  /** Muestra el aviso. Resuelve cuando ya se ha pintado. */
  begin(label: string): Promise<void>;
  /** Retira el aviso. */
  end(): void;
}

/** Dos fotogramas: el primero programa, el segundo se ejecuta con el velo ya pintado. */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

/** Diametro de la masa, en px. Tiene que coincidir con `.busy-matter` del CSS. */
const MATTER = 96;
