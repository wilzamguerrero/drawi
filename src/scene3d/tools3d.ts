/**
 * Herramientas propias del visor espacial y sus ajustes.
 *
 * El modo 3D no secuestra el manifiesto de herramientas del 2D: tiene el suyo,
 * mas pequeno, porque sus herramientas no dibujan tinta vectorial sino trazos
 * espaciales y no comparten ni el contexto ni los gestos.
 *
 * El PINCEL, en cambio, si es el mismo: sus cuatro modos -trazo, relleno,
 * arrastre y borrador- son los de `BrushSettings`, y en el espacio significan lo
 * que su nombre dice. Lo que se anade aqui es lo que en 2D no existe: suavizar un
 * trazo ya dibujado, y el radio con el que se agarra.
 */

import type { BrushMode } from "../stroke/types";
import { DEFAULT_SNAP, type SnapSettings } from "./snap";
import { DEFAULT_PLACEMENT, type PlacementSettings } from "./placement";
import type { DrawPlaneKind } from "./drawplane";
import type { GizmoMode } from "./gizmo";
import type { PrimitiveKind } from "./objects";

/**
 * Herramientas del visor.
 *
 * `brush` y `smooth` trabajan sobre los trazos; `object` sobre las primitivas,
 * con su gizmo. Son herramientas distintas porque el gesto no significa lo mismo:
 * con el pincel, arrastrar dibuja; con objetos, arrastrar un eje del gizmo
 * transforma, y pulsar en el vacio selecciona o deselecciona.
 */
export type Tool3D = "brush" | "smooth" | "object";

export const TOOL3D_LABELS: Record<Tool3D, string> = {
  brush: "Pincel",
  smooth: "Suavizar",
  object: "Objetos",
};

export const TOOL3D_ORDER: Tool3D[] = ["brush", "smooth", "object"];

export interface Scene3DSettings {
  tool: Tool3D;
  /**
   * Radio de agarre, en unidades de mundo.
   *
   * Lo comparten el suavizado y el arrastre: es el tamano de la zona que la punta
   * afecta, y va aparte del tamano del pincel porque no son lo mismo -se puede
   * querer un pincel fino y una mano ancha para retocar-.
   */
  radius: number;
  /** Cuanto relaja cada fotograma mientras se arrastra, 0..1. */
  strength: number;
  /**
   * Mejora el trazo al soltarlo.
   *
   * Aplica un suavizado y una limpieza de esquinas al cerrar el gesto. Va
   * apagado por defecto: es un cambio silencioso en lo que se acaba de dibujar, y
   * eso solo debe pasar si se ha pedido.
   */
  refineOnRelease: boolean;
  /** Fuerza de esa mejora al soltar, 0..1. */
  refineStrength: number;
  /**
   * De donde toma el trazo su punto de arranque, a que eje va restringido y con
   * que direccion sale. Ver `snap.ts`.
   */
  snap: SnapSettings;
  /** Sobre qué plano cae el trazo: hacia la cámara, uno del mundo, o el del ancla. */
  drawPlane: DrawPlaneKind;
  /** A qué profundidad cae: en el plano, en el origen, en el ancla o sobre el trazo. */
  placement: PlacementSettings;
  /**
   * Rejilla del suelo.
   *
   * Su paso es el de `snap.gridStep`, no uno propio: lo que se ve tiene que ser
   * exactamente aquello a lo que se engancha el trazo, o la rejilla miente.
   */
  grid: {
    enabled: boolean;
    /** Opacidad de las lineas, 0..1. */
    opacity: number;
  };
  /**
   * Los trazos del espacio se ocultan tras los objetos solidos.
   *
   * Cuando esta encendido, un trazo pintado DETRAS de un cubo queda tapado por el,
   * como en una escena real: el trazo lee la profundidad del objeto (pero no la
   * escribe, para seguir componiendose por capas entre trazos). Apagado, los trazos
   * se dibujan siempre por encima -el comportamiento de lienzo plano-, util cuando
   * se usa el objeto solo como guia y no se quiere que recorte el dibujo.
   */
  occludeStrokes: boolean;
  /**
   * Los trazos del espacio proyectan su sombra.
   *
   * Cuando esta encendido -y la sombra del suelo lo esta-, cada trazo tira su
   * sombra con su forma sobre el suelo, los objetos y los demas trazos, con el
   * mismo mapa de sombra que los objetos. Va aparte porque es caro -el trazo
   * entra en el pase de sombra- y porque es una decision de dibujo: a veces se
   * quiere la silueta limpia sin que los trazos ensucien el suelo.
   */
  strokeShadow: boolean;
  /**
   * Los trazos y manchas reciben sombra.
   *
   * Cuando esta encendido -y la sombra lo esta-, un trazo que queda bajo la sombra
   * de un objeto o de otro trazo se oscurece, con el mismo mapa de sombra. Es el
   * complemento de `strokeShadow` (proyectar): uno tira la sombra, el otro la
   * recibe. Va aparte porque muestrea el mapa en el shader del trazo y no siempre
   * se quiere -a veces el dibujo debe leerse plano por encima de la escena-.
   */
  strokeReceiveShadow: boolean;
  /**
   * Sombras de los objetos sobre el suelo.
   *
   * Son sombras REALES: el mapa de sombra de three proyecta la silueta del objeto
   * y un plano receptor la recibe. Van aparte de las luces porque, aunque la luz
   * decide hacia donde caen, su presencia e intensidad son un recurso de dibujo que
   * el usuario gradua -una ilustracion pide una sombra mas o menos marcada segun el
   * gusto, no segun la fisica-.
   */
  shadow: {
    enabled: boolean;
    /** Opacidad de la sombra sobre el suelo, 0..1. */
    opacity: number;
    /**
     * Suavidad del borde, 0..1.
     *
     * A 0 el borde es neto; subiendo, el mapa de sombra se desenfoca (penumbra) y
     * la sombra se ablanda. Es el equivalente real del antiguo disco difuso.
     */
    softness: number;
    /** Color de la sombra. Negra por defecto; un tinte frio o calido la integra. */
    color: string;
    /**
     * Alcance del mapa de sombra, en unidades de mundo.
     *
     * Es el radio del volumen que la luz abarca al proyectar: una escena pequeña
     * quiere poco alcance -mas resolucion efectiva, borde mas fino-, y una grande
     * necesita mas para que la sombra no se corte. Es el "hasta donde llega".
     */
    extent: number;
    /**
     * Nitidez del mapa de sombra: lado de la textura, en texeles.
     *
     * Mas texeles = borde mas limpio y detalle mas fino, a cambio de memoria y
     * coste. Cambiarlo obliga a tirar el mapa anterior (three no lo redimensiona).
     */
    resolution: number;
  };
  /** Modo del gizmo cuando la herramienta es `object`: mover, rotar o escalar. */
  gizmo: GizmoMode;
  /** Primitiva que inserta el boton "Insertar". */
  primitive: PrimitiveKind;
}

export const DEFAULT_SCENE3D: Scene3DSettings = {
  tool: "brush",
  radius: 40,
  strength: 0.35,
  refineOnRelease: false,
  refineStrength: 0.5,
  snap: { ...DEFAULT_SNAP },
  drawPlane: "view",
  placement: { ...DEFAULT_PLACEMENT },
  grid: { enabled: false, opacity: 0.55 },
  shadow: { enabled: true, opacity: 0.4, softness: 0.4, color: "#000000", extent: 1200, resolution: 2048 },
  occludeStrokes: true,
  strokeShadow: false,
  strokeReceiveShadow: false,
  gizmo: "move",
  primitive: "box",
};

/**
 * Que hace el puntero en el espacio ahora mismo, en una palabra.
 *
 * Vive aqui y no en el visor porque lo dicen dos sitios -el propio visor y la
 * barra de estado-, y dos listas de palabras para lo mismo se desvian.
 */
export const spaceToolLabel = (settings: Scene3DSettings, mode: BrushMode): string => {
  if (settings.tool === "object") return `objeto · ${settings.gizmo}`;
  if (settings.tool === "smooth") return "suavizar";
  if (mode === "erase") return "borrador";
  if (mode === "pull") return "arrastre";
  if (mode === "fill") return "relleno";
  return "trazo";
};
