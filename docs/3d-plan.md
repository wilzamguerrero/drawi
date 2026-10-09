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
| `src/render3d/backend.ts` | Escena three.js, sincronizado incremental, más la cinta provisional del trazo en curso |
| `src/app/viewport3d.ts` | El visor: lienzo, entrada, cámara y dibujado |

### Trazo, capas y documento

| Módulo | Qué resuelve |
|---|---|
| `src/scene/document.ts` | Los trazos del espacio viven en `strokes3d`, con capas `kind: "scene3d"`; instantánea y restauración para el historial |
| `src/scene3d/batch.ts` | Juntas sin muesca, `packSegments` compartido y `sync`, que hace de la escena una función pura del documento |
| `src/scene3d/relax.ts` | Editar trazos ya dibujados: suavizado laplaciano y arrastre con caída |
| `src/scene3d/fill.ts` | Manchas rellenas: contorno, triangulación por recorte de orejas y lotes |
| `src/scene3d/tools3d.ts` | Herramienta del visor y sus ajustes |
| `src/render3d/fill.ts` | Malla y material de las manchas |
| `src/io/project.ts` | Los trazos viajan en el proyecto (v7) con los puntos en base64 |

### Pruebas

- `scripts/smoke-3d.ts`: **141 comprobaciones**, la suite `3d` de `npm run smoke`.
- `scripts/verify-render3d.mjs`: **16 comprobaciones en un Chrome real**, que
  dibuja con el ratón y **lee los píxeles**. Se ejecuta con `npm run verify:3d`.
  No forma parte de `npm test` porque necesita un navegador descargado.

Total del proyecto: **319 comprobaciones** (68 motor 2D + 110 interfaz + 141 del 3D).

## 3. Qué NO está construido

- **Continuación del trazo** (encadenar al anterior, ejes, anclaje).
- **Luces, materiales, primitivas y posprocesado.**
- **Descarte y LOD por trazo** en el bucle de dibujado. El módulo está escrito y
  probado, pero el visor dibuja el lote entero y deja el recorte a la GPU.
- **`asMatter` y `asAqua` en 3D.** Sigue siendo la pregunta de diseño abierta.
- **Reparto en trozos del paquete.** El `bundle` pasó de ~500 kB a 886 kB por
  three.js. Se arregla cargando el backend con `import()` dinámico la primera vez
  que se entra al modo 3D.
- **La exportación no incluye el espacio** cuando hay trazos 3D: `renderToCanvas`
  recorre la tinta, la materia y la acuarela, pero no el visor.

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

### 4.9b El pincel es el mismo; la herramienta de retoque no

Los cuatro modos del pincel —trazo, relleno, arrastre y borrador— son los de
`BrushSettings`, compartidos con el lienzo, y en el espacio significan lo que su
nombre dice. Lo que se añade aparte es lo que en 2D no existe: **suavizar** un
trazo ya dibujado. Por eso hay dos cosas distintas y no una:

- `BrushSettings.mode` manda cuando la herramienta es el pincel.
- `Scene3DSettings.tool` (`pincel` | `suavizar`) es del visor, y se antepone al
  modo. `Scene3DSettings` va en el editor y **no** en `BrushSettings`: el radio de
  agarre y la fuerza del suavizado no significan nada en el lienzo 2D, y meterlos
  allí sería cargar el motor compartido con opciones ajenas.

El despacho es un único campo con etiqueta (`Gesture`) en vez de varios booleanos,
porque los gestos son excluyentes y cada uno lleva sus datos.

**No hay un panel de 3D aparte.** El interruptor del espacio vive en el panel del
pincel, junto a "Hacer materia" y "Acuarela", con sus opciones debajo y visibles
solo cuando está encendido. Los modos del pincel **no se repiten** allí: los manda
el selector del propio pincel, que es el mismo, y en el espacio significan lo que
significan en el lienzo. Un panel con una copia de los mismos cuatro modos sería
una segunda fuente de verdad para el mismo dato.

**El arrastre en el espacio estira una forma, igual que en el lienzo.** No es una
invención para 3D: es la mecánica de Alchemy que ya usa el 2D, con las mismas
familias (`pull-shapes.ts`) y la misma colocación. Lo único que cambia es el
soporte: la forma se calcula en coordenadas del plano de dibujo -que es una base
ortonormal, así que proyectar y volver es exacto- y se estampa como mancha, que es
exactamente lo que es: una superficie con área.

**El borrador es el del pincel.** No hay un borrador del espacio: al elegir
Borrador, el gesto del visor quita los trazos que toca. En el espacio no hay
ráster que recortar, así que equivale al submodo "Objeto" del borrador del lienzo.

### 4.9c Suavizar se acumula; arrastrar no

Dos gestos que parecen el mismo y no lo son:

- **Suavizar** aplica una pasada sobre el estado ACTUAL. Insistir con el puntero
  sobre la misma zona suaviza más, que es como se dosifica un suavizado a mano; la
  fuerza por fotograma es lo que lo hace controlable.
- **Arrastrar** aplica el desplazamiento TOTAL sobre la forma ORIGINAL, guardada al
  empezar el gesto, y no el incremento sobre lo ya movido. Si acumulara, arrastrar
  en círculo y volver al punto de partida no devolvería el trazo a su sitio: se
  quedaría donde lo dejó el último fotograma.

Los dos abren un solo paso de historial para todo el gesto, y cancelar a mitad
llama a `History.rollback()`, que devuelve el documento a la instantánea que se
fotografió al empezar. Sin eso, cancelar dejaba el trazo a medio retocar.

### 4.9d El trazo guarda el plano sobre el que se dibujó

Editar un trazo —suavizarlo, arrastrarlo— obliga a rehacer los marcos de la cinta,
porque están calculados para la forma vieja. Y los marcos dependen de la normal del
plano de dibujo: sin ella, el recálculo daría una orientación distinta y la cinta
se retorcería al retocar el trazo. Son tres floats por trazo y viajan en el
proyecto.

### 4.9e Una mancha rellena no es un trazo grueso

Los cuatro modos del pincel tienen su equivalente en el espacio, pero el relleno
no se puede construir con la cinta: la cinta es **un quad por segmento**, y un
quad no tiene interior. Una mancha es una superficie con área, así que es una
primitiva propia, con su modelo, su malla y su sombreado.

Dos decisiones dentro de ella:

- **Se guarda el contorno, no los triángulos.** El contorno es lo que se dibujó;
  los triángulos son geometría derivada, como los segmentos lo son de los puntos
  de un trazo. Guardarlos sería una segunda fuente de verdad que se desvía en
  cuanto se toque el algoritmo de triangulación.
- **Se triangula por recorte de orejas, no por abanico desde el centro.** Un
  abanico solo rellena bien lo convexo, y un contorno trazado a mano tiene
  entrantes con facilidad: en una ese, deja triángulos fuera y huecos dentro. Si
  el contorno se cruza consigo mismo el recorte se atasca, y entonces se remata lo
  que queda con un abanico en vez de no dibujar nada.

El orden de dibujado dentro de una capa es fijo: **las manchas antes que los
trazos**, para que las líneas se lean por encima de la materia. Se consigue
numerando el `renderOrder` de la capa por dos, dejando el `+ 1` para la cinta.

### 4.13 El espacio no es un modo del que se sale: es una capa

Al principio el visor se encendía y se apagaba entero: al salir, su lienzo se
ocultaba y lo dibujado en el espacio desaparecía de la vista. Eso obligaba a
elegir entre trabajar en el lienzo o en el espacio, y se sentía como cambiar de
programa.

Ahora son **dos cosas separadas**:

- **`showing`**: hay algo del espacio a la vista y su lienzo se compone sobre el
  lienzo 2D. Se enciende solo cuando existe alguna capa del espacio visible con
  trazos o manchas, para no componer un lienzo WebGL a pantalla completa en cada
  fotograma sin enseñar nada.
- **`live`**: el espacio recibe el puntero. Fuera de él, su lienzo lleva
  `pointer-events: none` y los eventos llegan al editor 2D como siempre.

De ahí sale lo que se pedía: se sigue viendo el espacio mientras se dibuja tinta,
y no hace falta salir de nada para estar en lo otro.

**Dentro del espacio se ve todo lo demás.** El lienzo del visor es **transparente**
—el papel lo pone el fondo del anfitrión, que está por debajo de todas las capas—,
así que la tinta, la acuarela y la materia se ven a través de él. Y el bucle 2D ya
no se salta: antes, con el espacio delante, `frame` volvía enseguida y el lienzo 2D
no se pintaba, lo que dejaba el espacio aislado. Lo que sigue congelado es la
**simulación** —física, fluido y la ondulación de los puentes—, porque lo que se
mueve solo bajo el lápiz distrae y la GPU que pide el visor no sobra. El dibujado,
en cambio, va con su propio aviso de sucio: con el espacio delante el 2D solo se
recompone cuando algo suyo cambia, no en cada fotograma.

**El modo sigue a la capa activa.** Elegir la capa del espacio pone el puntero en
el espacio; elegir cualquier otra lo devuelve al lienzo. El atajo y el interruptor
siguen existiendo, y hacen lo mismo por el otro lado: cambian también la capa
activa, para que el panel no mienta sobre dónde va a caer el trazo.

**Al entrar ya no se encuadra.** Antes el visor encuadraba lo dibujado al activarse.
Ahora que entrar y salir es cambiar de capa, eso movería la vista cada vez que se
toca el panel. Encuadrar es `F`, el botón del panel y el menú de la capa.

Consecuencia que conviene tener presente: **el lienzo del espacio va encima de la
pila 2D**, así que su contenido tapa la tinta donde se solapen. Lo correcto es
componerlo en su sitio de la pila —el backend ya se escribió pensando en eso, y la
acuarela y la materia ya lo hacen—, pero eso pide tocar el compositor 2D y queda
como paso siguiente. Mientras tanto se ve todo, que es lo que se pedía; lo que no
está resuelto es el orden entre las dos.

### 4.10 Los segmentos se prolongan en las juntas

Cada segmento es un quad independiente, así que en un cambio de dirección las dos
orillas exteriores no llegan a tocarse y queda una muesca blanca en el codo. La
CPU —que es la única que conoce a los vecinos— prolonga cada segmento hacia el
siguiente por `r * tan(theta/2)`, acotado a `[0.15 * r, r]`:

- Sobre una recta tiende a cero, así que no se solapa nada que no haga falta.
- En un codo de 90 grados vale exactamente el radio, que es la tapa redonda que
  cubre la junta entera.
- Más allá se acota al radio: la tapa redonda ya cubre.

El suelo de `0.15 * r` es una **precaución**, no una cura demostrada: la medición
sobre un trazo recto no reproduce la costura que viene a evitar. Se mantiene
porque cuesta poco y porque la verificación corre sobre el rasterizador por
software de Chrome, cuyo antialias no tiene por qué repartir las muestras como el
de una GPU real.

Esto cuesta dos floats por segmento (56 → 64 bytes) y obligó a subir el muestreo
mínimo a `max(0.55 / zoom, 0.5 * r)`: con pincel grueso los segmentos quedaban
mucho más cortos que el radio y el solape se desproporcionaba. Ese muestreo es
**idéntico en los dos constructores**, y hay una prueba que lo comprueba punto por
punto contra el lienzo 2D.

### 4.11 El trazo se ve mientras se dibuja

El trazo entraba en la escena solo al soltar el puntero: se dibujaba a ciegas, que
es lo que hacía que dibujar se sintiera lento. Ahora `Stroke3DBuilder.preview()`
devuelve el trazo en curso —sin decimar, y con el punto crudo bajo el cursor
añadido como cola, porque el muestreo mínimo hace que la punta real vaya por
detrás del lápiz— y el backend lo pinta en una cinta provisional propia, con
`renderOrder` por encima de los lotes. Se recompone **una vez por fotograma**, no
una por evento de puntero.

### 4.12 Los trazos del espacio viven en el documento

`Viewport3D` ya no es el dueño de los trazos: viven en `doc.strokes3d`, con el
mismo modelo que `doc.items` —lista plana, cada trazo con su `layerId`, el orden
del array como z dentro de la capa y el orden de `doc.layers` como z entre capas—.
`StrokeScene.sync()` reconcilia los lotes con esa lista, y de ahí salen gratis
deshacer, rehacer y editar un trazo ya dibujado, porque los tres se reducen a
cambiar la lista.

Consecuencia que conviene tener presente: reconciliar cuesta un recorrido de la
lista, así que el visor solo lo hace cuando el documento avisa
(`strokes3dRevision`), nunca en cada fotograma. Y como el visor conserva el buffer
de dibujado, hay un segundo aviso (`inkRevision`) que marca sucio cuando cambia la
pila de capas: sin él, apagar una capa dejaba el lienzo con el fotograma anterior.

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
| 7 trazos dibujados a mano | **1 draw call**, 248 segmentos |
| A medio gesto, con el puntero apoyado | **2.090 píxeles** pintados y **0 trazos** en la escena (antes: 0 píxeles) |
| Espina de un trazo, punta a punta | alfa mínimo **255**, hueco mayor **0 px** en 279 px |
| Codos de un zigzag, ventana de 7,7 px en cada uno | **0 píxeles** sin pintar (sin prolongar los segmentos: **229**) |
| Apagar la capa del espacio | 26.034 píxeles → **0** |
| Ida y vuelta de 40 puntos al proyecto | desvío máximo **0** |
| Píxeles pintados | 26.037 (3,11 % del lienzo) |
| Borrar un trazo | −1.506 píxeles |
| Orbitar | cambia la imagen y añade **0 trazos** |

**Esto se mide con el rasterizador por software de Chrome, no con una GPU.** El
rendimiento real está sin medir: falta presupuestar los 60 fps con 20.000 trazos.

## 6. Fases pendientes

1. El relleno en el espacio, con su propia geometría de superficie.
2. Continuación del trazo: encadenar al anterior o al más cercano, ejes,
   continuidad de tangente y anclaje.
3. Conectar `cull.ts` al bucle de dibujado, con el descarte por lotes primero.
4. Primitivas, luces, materiales y posprocesado.
5. Incluir el espacio en la exportación.
6. Respaldo por CPU, solo como visor.
7. Repartir el paquete para que three.js no pese hasta que se use.
8. Medir el rendimiento con GPU real.

## 7. Reglas que no se pueden romper

1. El motor 2D no se toca; sus 68 pruebas son la red.
2. Los trazos son inmutables y son la verdad; la geometría es derivada.
3. Los buffers de la GPU nunca entran en el historial ni en el archivo.
4. Ningún objeto JS por punto.
5. Nada de una malla por trazo.
6. **El índice de instancia y el de datos tienen que coincidir.** Cualquier
   desplazamiento entre ellos hace que un trazo lea los puntos de otro.
7. Navegar no dibuja; dibujar no mueve la cámara.
8. **La escena es una función pura del documento.** Los lotes se reconcilian con
   `doc.strokes3d`; nada se edita en la escena sin pasar por el documento.
9. **La dinámica del pincel es idéntica en 2D y en 3D**, muestreo mínimo
   incluido. Cualquier cambio en uno va en los dos, o la prueba de paridad lo
   caza.
