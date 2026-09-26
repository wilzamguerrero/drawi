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

Animación de entrada estilo menú radial adaptada a un cuadro (pedido del usuario 2026-09-26): partículas `solidCore:true` que forman una masa rectangular llena, relevo a `gatherMs` completo, y el diálogo CRECE desde el centro (`scale(0.62)→1`, curva `cubic-bezier(0.22,1,0.36,1)`) en vez de subir. Padding generoso (`.cmd-content` 26/30/28) para separar el contenido del borde ondulante (`MateriaEdge` inset 16 / amplitude 9 / radius 22).

Reutiliza el lenguaje de animación descrito en [[materia-ui-language]]. Para añadir una orden nueva, basta con un objeto más en `buildCommands()`.
