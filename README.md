# drawi

Laboratorio de dibujo generativo y **materia 2.5D**. Toma la idea de Alchemy y
[Webchemy](https://webchemy.org/) —trazos que no buscan la precisión sino el
descubrimiento— y le añade un lápiz que responde de verdad, simetría que se
mueve por el lienzo y una física donde las formas se **funden como un metaball**
conservando su silueta.

Sin framework de interfaz, sin dependencias en tiempo de ejecución: solo
TypeScript, Canvas2D y WebGL2. El único paquete que se instala es la cadena de
compilación (Vite + TypeScript).

---

## Qué hace

### Pincel — más modos que el original
Webchemy mantiene la línea con un ancho constante. Aquí el ancho se puede derivar
de cinco maneras (menú **Dinámica** del inspector):

| Modo | Qué hace |
|------|----------|
| **Constante** | Ancho fijo. El trazo clásico de Alchemy. |
| **Presión** | El ancho sigue la presión del lápiz (con ratón usa la velocidad como sustituto). |
| **Velocidad** | Trazo de tinta: rápido adelgaza, lento engorda. Invertible. |
| **Presión + velocidad** | Mezcla ambas; la que mejor imita un pincel real. |
| **Inclinación** | Punta de cincel: ancho y ángulo dependen de cómo inclines el lápiz. |

Se conservan los tres **modos de pincel** de Webchemy —**Trazo**, **Relleno** y
**Arrastre** (*pull-shapes*, con siete familias: blob, hoja, astilla, pétalo,
media luna, cinta, runa)— y sus dos modificadores, **Degradado** y **Splat**
(contorno anguloso).

### Lápiz que responde
El fallo del original no era solo la falta de presión, sino la **latencia**. Aquí:

- Se leen los **eventos coalescidos** del navegador, así que no se pierde
  ninguna muestra entre fotogramas, y los **predichos** para adelantar la punta.
- La entrada se suaviza con un filtro **One-Euro**, no con una media móvil: quita
  el temblor fino sin añadir el retraso constante que hace sentir la línea
  pegajosa (medido: temblor por debajo de 0,3 px, retraso por debajo de 12 px en
  trazo rápido).
- Se aprovecha todo lo que informa el dispositivo: **inclinación y azimut**,
  **punta de goma**, **botón lateral**, giro del barril y rechazo de palma.

### Simetría movible
El eje es un objeto del lienzo, no un ajuste fijo. Con la herramienta de simetría
(`S`) se **arrastra su origen** a donde quieras, se **gira** tirando del brazo y
se cambia el número de sectores. Modos: **ninguno**, **espejo**, **radial** y
**caleidoscopio**. Todo lo que dibujas se replica en vivo.

### Física — formas que se funden
Crea formas básicas (**círculo, caja, cápsula, polígono, estrella**) y suéltalas
en el lienzo. Cada una aporta un **campo de distancia con signo** (SDF) y todas
se unen con una **mezcla suave** (*smooth-min* polinómica): al acercarse generan
el puente continuo de un metaball, pero conservando su silueta real —una caja
sigue teniendo esquinas, una estrella sigue teniendo puntas.

Debajo hay un motor de **cuerpos rígidos 2D** propio, sin dependencias: SAT +
recorte para el contacto, impulsos secuenciales con corrección de Baumgarte,
paso fijo a 1/120 s con acumulador, reposo de cuerpos, cohesión (la materia «se
llama») y paredes de contenedor. La materia fundida se puede **hornear** a tinta
editable.

### Lo demás
Deshacer/rehacer por instantáneas · zoom, desplazamiento y giro de cámara ·
paletas de color y cuentagotas · exportar **PNG** (1×–4×, con margen y fondo
configurables) y **SVG** · guardar/abrir proyecto `.drawi` · autoguardado en el
navegador.

---

## Empezar

```bash
npm install
npm run dev        # servidor de desarrollo (Vite)
npm run build      # typecheck + build de producción
npm run preview    # sirve el build
```

### Comprobaciones

```bash
npm run check      # tsc --noEmit (incluye scripts/)
npm run smoke      # dos suites de humo sobre un DOM simulado
npm test           # check + smoke
```

No hay navegador sin cabeza en la CI. En su lugar, `scripts/dom-shim.mjs`
implementa exactamente la superficie de DOM que la aplicación usa, y las suites
se empaquetan con la propia API de Vite para probar el mismo grafo de módulos que
se publica:

- **`smoke-engine`** (motor): mide magnitudes concretas —el ensanchado por
  presión, la convergencia y el retraso del filtro, que el colisionador y el
  contorno dibujado describan la misma forma, la fusión tipo metaball y la
  estabilidad de una pila de cuerpos.
- **`smoke-ui`** (interfaz): construye la aplicación entera sobre el DOM
  simulado y la conduce como una persona —eventos de puntero reales, clic en
  todos los botones, cambio en todos los controles— comprobando el cableado
  entre UI, editor y herramientas.

---

## Atajos

**Herramientas** · `B` pincel · `F` forma física · `M` mover materia · `S` eje de
simetría · `I` cuentagotas · `H`/`Espacio` mano

**Pincel** · `1`/`2`/`3` trazo/relleno/arrastre · `[`/`]` tamaño · `G` degradado ·
`P` splat · botón lateral del lápiz borra o quita materia · punta de goma pinta
con el color del fondo

**Vista e historial** · rueda para desplazar (con `Ctrl`, zoom) · dos dedos para
zoom y desplazamiento · `0` restablece la vista · `Ctrl+Z` / `Ctrl+Shift+Z`
deshacer/rehacer · `Shift+Supr` limpiar todo · `Esc` cancelar el gesto en curso

---

## Arquitectura

```
src/
  core/       matemáticas, matrices, color, RNG, emisor de eventos tipado
  input/      eventos de puntero: coalescidos, predichos, tilt, goma, palma
  stroke/     filtro One-Euro, dinámicas del trazo, contorno de ancho variable
  symmetry/   ejes movibles y sus transformaciones
  physics/    SDF, marching squares, formas, mundo de cuerpos rígidos
  render/     capas: tinta (Canvas2D), campo (WebGL2 con respaldo 2D), overlay
  scene/      documento y tipos de la escena
  io/         exportación PNG/SVG, proyecto .drawi
  app/        editor (estado) e historial
  tools/      pincel, forma, materia, simetría, cuentagotas
  ui/         interfaz a mano (sin framework): barras, inspector, popovers
```

**Una regla que no se puede romper:** las SDF están duplicadas en GLSL
(`render/field-gl.ts`) y en TypeScript (`physics/sdf.ts`) para pintar en la GPU y
calcular en la CPU la misma forma. `shapeParams()` es la única fuente que
alimenta a ambas; si cambia una, tiene que cambiar la otra, y la suite del motor
lo verifica.

## Créditos

Inspirado en [Alchemy](http://al.chemy.org/) de Karl D.D. Willis y Jacob Hina, y
en la recreación web [Webchemy](https://webchemy.org/) (incluida en `references/`
como material de estudio). drawi es una implementación independiente.
