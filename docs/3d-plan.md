# Modo 3D: arquitectura y estado

Este documento recoge las decisiones del modo de dibujo espacial y el estado real
de la implementación. Sustituye a `references/featheridea.md` como referencia
técnica: aquel archivo mezcla visión, plan y material de Feather, y sigue siendo
útil como cuaderno de fuentes, pero no como especificación.

## 1. Cómo se usa

- **Ctrl+3** entra y sale del espacio (el `3` a secas ya es el modo arrastre del
  pincel; robar esa tecla habría sido una regresión silenciosa). También hay un
  botón **3D** en la barra superior, que queda inerte sin WebGL2.
- Con el modo activo: el lápiz dibuja, el **botón central o el derecho** orbitan,
  **Shift + arrastrar** desplaza, la **rueda** acerca, **`[` y `]`** mueven la
  profundidad del plano de dibujo, **F** encuadra lo dibujado y **Alt + clic**
  borra el trazo bajo el cursor.

## 2. Qué está construido y verificado

### Núcleo de datos y matemáticas

Sin dependencia de WebGL ni del DOM, así que corre en las pruebas de Node.

| Módulo | Qué resuelve |
|---|---|
| `src/stroke/dynamics.ts` | Dinámica del pincel compartida por 2D y 3D |
| `src/scene3d/vec3.ts` | Vector 3D y utilidades geométricas |
| `src/scene3d/types.ts` | Modelo empaquetado del trazo, cajas envolventes |
| `src/scene3d/frames.ts` | Marcos que minimizan la rotación (reflexión doble) |
| `src/scene3d/simplify.ts` | Decimación con error de posición **y** de radio |
| `src/scene3d/builder.ts` | Constructor de trazos 3D |
| `src/scene3d/camera3d.ts` | Cámara orbital, proyección y frustum |
| `src/scene3d/controls3d.ts` | Gestos de cámara y trazado de rayo al plano |
| `src/scene3d/batch.ts` | Lotes: N trazos, una draw call |
| `src/scene3d/cull.ts` | Descarte por frustum y nivel de detalle |

### Render y aplicación

| Módulo | Qué resuelve |
|---|---|
| `src/render3d/ribbon.ts` | Shader que construye la cinta en la GPU |
| `src/render3d/backend.ts` | Escena three.js, sincronizado incremental |
| `src/app/viewport3d.ts` | El visor: lienzo, entrada, cámara y dibujado |

### Pruebas

- `scripts/smoke-3d.ts`: **141 comprobaciones**, la suite `3d` de `npm run smoke`.
- `scripts/verify-render3d.mjs`: **16 comprobaciones en un Chrome real**, que
  dibuja con el ratón y **lee los píxeles**. Se ejecuta con `npm run verify:3d`.
  No forma parte de `npm test` porque necesita un navegador descargado.

Total del proyecto: **319 comprobaciones** (68 motor 2D + 110 interfaz + 141 del 3D).

## 3. Qué NO está construido

- **Persistencia**: los trazos 3D viven solo en memoria. Falta la capa
  `scene3d` en el documento y subir `PROJECT_VERSION` a 7.
- **Deshacer y rehacer** en las operaciones del espacio. El modelo lo permite
  —los trazos son inmutables y los lotes son derivados— pero no está conectado.
- **Respaldo por CPU**: solo como visor, con Canvas2D e impostores.
- **Luces, materiales y posprocesado.**
- **Descarte y LOD por trazo** en el bucle de dibujado. El módulo está escrito y
  probado, pero el visor dibuja el lote entero y deja el recorte a la GPU.
- **`asMatter` y `asAqua` en 3D.** Sigue siendo la pregunta de diseño abierta.
- **Reparto en trozos del paquete.** El `bundle` pasó de ~500 kB a 886 kB por
  three.js. Se arregla cargando el backend con `import()` dinámico la primera vez
  que se entra al modo 3D.

## 4. Decisiones, con su porqué

### 4.1 Los puntos van en un `Float32Array` empaquetado

Paso fijo de 9 floats (36 bytes) por punto: `pos(3) + normal(3) + radio(1) +
presión(1) + tiempo(1)`. En 2D un `StrokePoint` es un objeto con siete campos y da
igual; en 3D, 36 bytes frente a los ~120 de un objeto JS es la diferencia entre
40 MB y 150 MB para un dibujo denso.

### 4.2 No se guarda cuaternión por punto

Open Brush lo hace, y allí tiene sentido: un mando de VR entrega orientación de 6
DOF. Con lápiz solo hay presión e inclinación, así que el giro de la cinta **se
deriva del camino** con marcos que minimizan la rotación. Se ahorran 4 floats por
punto (un 40 %) y desaparece una fuente de ruido.

### 4.3 La dinámica del pincel es la misma en 2D y en 3D

`resolveRadius` y `taperFactor` viven en `src/stroke/dynamics.ts` y los usan los
dos constructores. Hay una prueba que lo verifica de forma directa: el mismo gesto
dibujado con `z = 0` produce exactamente los mismos radios en los dos motores. Hoy
el desvío medido es **0.000000**.

### 4.4 El lote guarda **segmentos**, no puntos

Es la decisión más importante del sistema y la que costó dos fallos graves.

Cada entrada del buffer es un segmento con sus dos extremos ya resueltos:

```
[ posA(3) normalA(3) radioA(1) | posB(3) normalB(3) radioB(1) ]   = 14 floats
```

Cuesta más memoria que guardar puntos (56 bytes por segmento frente a 36 por
punto, porque cada punto aparece en dos segmentos), pero a cambio **el índice de
instancia y el de datos coinciden**.

Esa igualdad no es un detalle: es la corrección entera del sistema. La primera
versión guardaba puntos y dejaba que el shader leyera `puntos[i]` y `puntos[i+1]`
con el índice de instancia, con un punto centinela al final de cada trazo para
cortar la cinta en la frontera. El centinela desplazaba los índices, así que **a
partir del segundo trazo cada segmento leía los puntos de otro trazo**: el último
trazo dibujado no aparecía en pantalla y los anteriores salían ligeramente
corridos, sin que nada lanzara un error. Los arcos se veían «bien» por casualidad
—una curva densa desplazada un punto sigue siendo casi la misma curva—, lo que
hizo el fallo mucho más difícil de ver.

La prueba que lo cubre está en la suite: comprueba **extremo por extremo** que
cada segmento une los puntos de su propio trazo.

### 4.5 Borrar no compacta

Al borrar un trazo se ponen sus radios a cero: el segmento queda degenerado y la
GPU lo descarta sin coste. El hueco se conserva y los rangos posteriores no se
mueven. Solo se compacta cuando el desperdicio pasa del 35 %.

Compactar en cada borrado obligaría a reescribir el buffer y a recolocar todos los
rangos siguientes; con deshacer y rehacer encima, ese es exactamente el trabajo que
hace que una aplicación se sienta lenta. Es el mismo criterio que usa Open Brush en
`Batch.DisableSubset`, verificado en su código.

### 4.6 Orden de pintado, no z-buffer

Todos los trazos de una sesión viven sobre el mismo plano de dibujo, así que son
coplanares. Con el z-buffer activo eso es z-fighting, y además el rango de
profundidad útil (de 4 a 54.000 unidades) deja muy poca precisión a la distancia
de trabajo. Se dibujan en orden de creación y se dejan superponer, que es lo que
hace que un trazo se lea como materia puesta encima de otra.

### 4.7 El contexto WebGL se crea **una sola vez**

`getContext` solo atiende la primera llamada por lienzo, y las siguientes
devuelven el mismo contexto **ignorando los atributos**. Sondeando antes con
`canvas.getContext("webgl2")` el contexto quedaba creado con los atributos por
defecto, así que `preserveDrawingBuffer` nunca llegaba a aplicarse: el visor
pintaba, pero el buffer se vaciaba al componer y el lienzo se leía vacío. Ahora se
crea el contexto con los atributos definitivos y se le pasa a three.

### 4.8 Los lotes son datos derivados y nunca se guardan

Nada de esto entra en el documento ni en el historial: se reconstruye al abrir. En
Open Brush el campo equivalente lleva `[NonSerialized]` con el comentario *"built
at runtime by the batcher; never authored in a scene or prefab"*.

### 4.9 El visor captura el puntero antes que el editor

Los manejadores del 2D escuchan en fase de burbuja sobre el anfitrión, así que un
`stopPropagation` en fase de captura sobre el lienzo del visor basta para que el
motor 2D no vea nada mientras el modo 3D está activo. Ni una herramienta tuvo que
enterarse de que el 3D existe.

## 5. Medido

Con la suite de pruebas:

| Magnitud | Medición |
|---|---|
| 20.000 trazos, 3 pinceles | **3 lotes** = 3 draw calls |
| Memoria de esos 20.000 trazos | 47 MB a 56 bytes por segmento |
| Un gesto normal | 320 → 34.8 puntos (89 % menos) |
| Desvío 2D ↔ 3D del radio | **0.000000** |
| Torsión de la cinta sobre un plano | **0.0000 rad** |

Con el navegador (`npm run verify:3d`, 1100×760):

| Magnitud | Medición |
|---|---|
| 7 trazos dibujados a mano | **1 draw call**, 251 segmentos |
| Píxeles pintados | 26.037 (3,11 % del lienzo) |
| Borrar un trazo | −1.506 píxeles |
| Orbitar | cambia la imagen y añade **0 trazos** |

**Esto se mide con el rasterizador por software de Chrome, no con una GPU.** El
rendimiento real está sin medir: falta presupuestar los 60 fps con 20.000 trazos.

## 6. Fases pendientes

1. Persistencia: capa `scene3d` y `PROJECT_VERSION` 7.
2. Deshacer y rehacer en el espacio.
3. Conectar `cull.ts` al bucle de dibujado, con el descarte por lotes primero.
4. Luces, materiales y posprocesado.
5. Respaldo por CPU, solo como visor.
6. Repartir el paquete para que three.js no pese hasta que se use.
7. Medir el rendimiento con GPU real.

## 7. Reglas que no se pueden romper

1. El motor 2D no se toca; sus 68 pruebas son la red.
2. Los trazos son inmutables y son la verdad; la geometría es derivada.
3. Los buffers de la GPU nunca entran en el historial ni en el archivo.
4. Ningún objeto JS por punto.
5. Nada de una malla por trazo.
6. **El índice de instancia y el de datos tienen que coincidir.** Cualquier
   desplazamiento entre ellos hace que un trazo lea los puntos de otro.
7. Navegar no dibuja; dibujar no mueve la cámara.
