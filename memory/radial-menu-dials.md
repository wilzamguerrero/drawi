---
name: radial-menu-dials
description: Radial menu DialNodes render as draggable arc-shaped sliders in their sector
metadata:
  type: project
---

En el menú radial (src/ui/hotbox/radial-menu.ts, clase `RadialMenu`), los `DialNode` (opciones numéricas: tamaño de pincel, opacidad, suavizado, params de forma, física, campo, simetría — declarados en src/ui/hotbox/menu.ts) NO son botones: se pintan y controlan como **sliders con la forma de su propio sector arco**.

Añadido 2026-09-26. Cómo funciona:
- El sector del dial es la PISTA (clase `.rm-sector.is-dial`, se queda oscura al hover para no tapar el nivel). Encima: un arco de RELLENO (`.rm-dial-fill`) que crece desde `angleStart` hasta el valor, y una AGUJA radial (`.rm-dial-thumb`) en esa posición. La lectura numérica va en la capa de iconos (`.rm-icon-dial`) y el centro muestra nombre + valor (`.rm-dial-name`/`.rm-dial-read`).
- Interacción: `onPointerDown` sobre un dial arranca el arrastre (`dragDial`), captura el puntero y salta el valor a donde se pulsó (como tocar un slider); `onPointerMove` mientras `dragDial` llama a `applyDialDrag` (mapea el ángulo del cursor a t∈[0,1] dentro de `[angleStart, angleEnd]`); `onPointerUp` termina. El arrastre hace bypass de la lógica de hover/expansión.
- Mapeo valor↔arco con la misma curva `gamma` que los sliders del panel (src/ui/controls.ts): `dialValueFromT` = min + pow(t, gamma)·(max−min), cuantizado por `step`; `dialTFromValue` la inversa (pow(norm, 1/gamma)). Helpers `arcD()` (compartido con `createArc`), `needleD()`, `dialText()` en radial-menu.ts.
- Al arrastrar se muta `node.value` del árbol actual y se llama `onInput(v)` (que aplica al editor); no se hace rebuild durante el arrastre. El siguiente `buildRoot` relee los valores frescos.

El hook que antes era el TODO `case "dial"` en `executeNode` quedó como no-op: el dial se maneja por arrastre, no por ejecución.

Comparte el lenguaje visual descrito en [[materia-ui-language]]. Para añadir un dial nuevo basta un objeto `{ kind: "dial", ... }` en `buildRoot()`/submenús de menu.ts; el renderer ya lo dibuja como arc-slider.
