/**
 * Iconos SVG en linea.
 *
 * Trazo de 1.7 y esquinas redondas en todos: mezclar grosores es lo que hace
 * que una barra de herramientas parezca ensamblada con piezas sueltas.
 */
const svg = (paths: string, extra = ""): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

export const ICONS: Record<string, string> = {
  brush: svg(
    `<path d="M15.5 3.5 20.5 8.5 11 18a4.2 4.2 0 0 1-2.2 1.2L4.5 20l.8-4.3A4.2 4.2 0 0 1 6.5 13.5Z"/><path d="M13.5 5.5 18.5 10.5"/>`,
  ),
  shape: svg(
    `<circle cx="9" cy="9" r="5"/><rect x="11" y="11" width="9" height="9" rx="2"/>`,
  ),
  matter: svg(
    `<circle cx="8.5" cy="12" r="4.5"/><circle cx="15.5" cy="12" r="4.5"/>`,
  ),
  symmetry: svg(
    `<path d="M12 3v18"/><path d="M8 7 4 12l4 5"/><path d="M16 7l4 5-4 5"/>`,
  ),
  picker: svg(
    `<path d="m19 5-1.5-1.5a2 2 0 0 0-2.8 0L12 6.2"/><path d="M12 6.2 17.8 12 8.4 21.4H3v-5.4Z"/>`,
  ),
  hand: svg(
    `<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M15 11V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-4.6-2.2L3.6 15a1.6 1.6 0 0 1 2.4-2L9 16"/>`,
  ),
  undo: svg(`<path d="M4 9h11a5 5 0 0 1 0 10h-5"/><path d="m8 5-4 4 4 4"/>`),
  redo: svg(`<path d="M20 9H9a5 5 0 0 0 0 10h5"/><path d="m16 5 4 4-4 4"/>`),
  trash: svg(
    `<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13h10l1-13"/>`,
  ),
  download: svg(`<path d="M12 4v11"/><path d="m8 11 4 4 4-4"/><path d="M4 19h16"/>`),
  upload: svg(`<path d="M12 20V9"/><path d="m8 13 4-4 4 4"/><path d="M4 5h16"/>`),
  play: svg(`<path d="M7 4.5 19 12 7 19.5Z"/>`),
  pause: svg(`<path d="M8 4.5v15"/><path d="M16 4.5v15"/>`),
  seed: svg(
    `<circle cx="7" cy="8" r="3"/><circle cx="16" cy="7" r="2.4"/><circle cx="13" cy="16" r="3.6"/>`,
  ),
  bake: svg(
    `<path d="M4 17h16"/><path d="M6 17a6 6 0 0 1 12 0"/><path d="M9 7.5c0-1 1-1.3 1-2.5"/><path d="M13 7.5c0-1 1-1.3 1-2.5"/>`,
  ),
  zoomIn: svg(`<circle cx="10.5" cy="10.5" r="6"/><path d="M10.5 8v5M8 10.5h5"/><path d="m15 15 4.5 4.5"/>`),
  zoomOut: svg(`<circle cx="10.5" cy="10.5" r="6"/><path d="M8 10.5h5"/><path d="m15 15 4.5 4.5"/>`),
  fit: svg(
    `<path d="M4 9V5h4"/><path d="M20 9V5h-4"/><path d="M4 15v4h4"/><path d="M20 15v4h-4"/>`,
  ),
  grid: svg(`<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16M15 4v16"/>`),
  layers: svg(`<path d="m12 4 8 4-8 4-8-4Z"/><path d="m4 13 8 4 8-4"/>`),
  save: svg(
    `<path d="M5 4h11l3 3v13H5Z"/><path d="M9 4v5h6V4"/><rect x="8" y="13" width="8" height="7"/>`,
  ),
  folder: svg(`<path d="M4 6h5l2 2h9v11H4Z"/>`),
  close: svg(`<path d="m6 6 12 12M18 6 6 18"/>`),
  chevron: svg(`<path d="m8 10 4 4 4-4"/>`),
  info: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>`),
  wheel: svg(
    `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6"/><path d="M12 15v6"/><path d="M3 12h6"/><path d="M15 12h6"/>`,
  ),
  eraser: svg(
    `<path d="m10 19 9-9-5-5-9 9 5 5Z"/><path d="M6 19h13"/>`,
  ),
  droplet: svg(`<path d="M12 3.5c3.5 4 5.5 6.7 5.5 9.5a5.5 5.5 0 0 1-11 0c0-2.8 2-5.5 5.5-9.5Z"/>`),
  tune: svg(
    `<path d="M6 4v6M6 14v6"/><circle cx="6" cy="12" r="2"/><path d="M14 4v2M14 10v10"/><circle cx="14" cy="8" r="2"/><path d="M20 4v10M20 18v2"/><circle cx="20" cy="16" r="2"/>`,
  ),
  compass: svg(`<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8Z"/>`),
  gear: svg(
    `<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>`,
  ),
  back: svg(`<path d="M15 6l-6 6 6 6"/>`),
  plus: svg(`<path d="M12 5v14M5 12h14"/>`),
  minus: svg(`<path d="M5 12h14"/>`),
  spark: svg(`<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/><path d="M12 9a3 3 0 0 0 3 3 3 3 0 0 0-3 3 3 3 0 0 0-3-3 3 3 0 0 0 3-3Z"/>`),
  pin: svg(`<path d="M12 3l4 4-1.5 1.5.8 5.2L12 12l-3.3 1.7.8-5.2L8 7Z"/><path d="M12 12v9"/>`),
  file: svg(`<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v4h4"/>`),
  export: svg(`<path d="M12 4v11"/><path d="m8 11 4 4 4-4"/><path d="M4 19h16"/>`),
  settings: svg(
    `<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>`,
  ),
  help: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9a2.5 2.5 0 0 1 5 1c0 1.5-2.5 2.5-2.5 3.5"/><path d="M12 17h.01"/>`),
  palette: svg(`<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1.5"/><circle cx="15.5" cy="10" r="1.5"/><circle cx="12" cy="15" r="1.5"/>`),
  image: svg(`<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m4 15 4-4 5 5 5-6 2 2v4H4Z"/>`),
  panel: svg(`<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M14 4v16"/>`),
};

export function icon(name: keyof typeof ICONS | string): string {
  return ICONS[name] ?? ICONS.info;
}
