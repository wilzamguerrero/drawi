---
name: command-palette-feature
description: The Ctrl/Cmd+K command palette for finding tools/actions by typing
metadata:
  type: project
---

Paletón de órdenes en Zence Draw: cuadro flotante que se abre con **Tab** (y Ctrl/Cmd+K como alternativa) para buscar herramientas y acciones escribiendo (filtro difuso por subsecuencia), navegar con ↑/↓ (o Tab/Shift+Tab dentro), ejecutar con Enter, cerrar con Esc.

Añadido 2026-09-26. Archivos:
- src/ui/command-palette.ts — componente `CommandPalette(editor, hooks)`; lista de órdenes en `buildCommands()` (herramientas primero, luego Color/Materia/Editar/Vista/Archivo).
- src/styles-command.css — estilos `.cmd-*`, hermanos de `.help-*`.
- Cableado en src/ui/app.ts: comparte el objeto `MenuHooks` con el menú radial; el disparador Ctrl+K va ANTES del filtro INPUT/TEXTAREA del keyHandler (para alternarlo desde su propio campo); el de **Tab** va DESPUÉS del filtro (para no robar el tabulado de un input) y solo abre cuando está cerrado.

Animación de entrada en TRES tiempos (afinada con el usuario 2026-09-26, varias rondas hasta "casi perfecto"):
1. La masa aparece en el CENTRO como un CÍRCULO pequeño (núcleo redondo, igual que el menú radial). `MateriaFx({ coreSize:120, reach:86, dots:16, solidCore:true, gatherMs:340, scatterMs:300 })` + `fx.gather()`. La caja espera invisible en `.is-forming` (`scale(0.985)`, opacity 0).
2. A `gatherMs`, ese círculo se EXPANDE con MÁS partículas hasta abarcar el cuadro: `fx.bloom(rw, rh, 22)` — método nuevo que NO usa `setRect` (para no romper la animación de help.ts que sí lo usa). El núcleo circular transiciona su tamaño/radio hasta el rectángulo y brotan `dots+12` gotas del centro a `--bx/--by`.
3. A `+bloomMs` (440), se quita `.is-forming`: la caja hace CROSSFADE suave sobre la masa (casi a tamaño real, no un segundo crecimiento) y `fx.fadeOut()`. A `+240ms`, `setRevealed(true)` + `playRowCascade()` + `focusInput()`: aparece el buscador y la lista cuaja fila a fila.

Piezas nuevas: `MateriaFx.bloom()` + `bloomMs` opción/propiedad (src/ui/fx/materia.ts); `.materia-fx-core-bloom`, `.materia-fx.is-blooming`, `@keyframes materia-bloom` (src/styles-fx.css). Padding generoso (`.cmd-content` 24/30/26) para separar el contenido del borde ondulante (`MateriaEdge` inset 16 / amplitude 9 / radius 22). La caja está centrada en la página (`.cmd-overlay` grid place-items:center) y es apaisada (`max-height: min(46vh, 360px)`).

Reutiliza el lenguaje de animación descrito en [[materia-ui-language]]. Para añadir una orden nueva, basta con un objeto más en `buildCommands()`.
