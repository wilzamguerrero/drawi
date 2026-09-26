---
name: materia-ui-language
description: Convention for floating UI in Zence Draw — reuse the shared materia animation system
metadata:
  type: feedback
---

En Zence Draw (E:\escrito 2026\documentos\drawi), toda UI flotante nueva debe compartir el mismo lenguaje de "materia" que el menú radial, el panel de ayuda y los paneles laterales. El usuario lo pidió explícitamente: "mantén el estilo que estamos desarrollando".

**Why:** la interfaz debe sentirse hecha de la misma materia; una animación distinta desentona.

**How to apply:**
- Entrada/salida por partículas: `MateriaFx` (src/ui/fx/materia.ts) — gotas gooey que se juntan al abrir (gather → fadeOut a ~50%) y se dispersan al cerrar (scatter). Para cuadros con piel propia usar `solidCore:false`.
- Borde vivo ondulante: `MateriaEdge` (src/ui/fx/materia-edge.ts) — `full:true` para cuadros que flotan (4 bordes), modo panel (3 bordes) para lo anclado a un marco. Relleno negro `#161619`.
- Copiar el patrón show()/hide() de [[command-palette-feature]] o de src/ui/help.ts: is-forming / is-revealed (cascada del contenido con `--i`) / is-closing, y sincronizar el rectángulo de las partículas con `syncFxToDialog()`.
- Los tiempos y el aspecto viven en src/styles-fx.css (compartido) + el CSS propio del componente.
