import type { SceneDocument } from "../scene/document";

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("No se pudo leer el archivo"));
    r.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("Imagen no decodificable"));
    img.src = dataUrl;
  });
}

export function isImageFile(file: File): boolean {
  const t = file.type.toLowerCase();
  if (t.startsWith("image/")) return true;
  const name = file.name.toLowerCase();
  return name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png") || name.endsWith(".webp") || name.endsWith(".gif") || name.endsWith(".bmp") || name.endsWith(".psd") || name.endsWith(".jpc") || name.endsWith(".jp2");
}

export function isPsdFile(file: File): boolean {
  const n = file.name.toLowerCase();
  return n.endsWith(".psd") || file.type === "image/vnd.adobe.photoshop";
}

/**
 * Importa una imagen como una nueva capa `image` (desbloqueada por defecto,
 * como pide el usuario poder bloquearla luego a voluntad). Colocada centrada
 * en la vista actual. Si el archivo es PSD y ag-psd está disponible, se
 * importa capa por capa; si no, se rasteriza como una sola imagen.
 */
export async function importImageFile(
  file: File,
  doc: SceneDocument,
  viewCenter: { x: number; y: number },
  maxEdge = 2048,
): Promise<number> {
  if (isPsdFile(file)) {
    const psdCount = await tryImportPsdByLayers(file, doc, viewCenter, maxEdge);
    if (psdCount > 0) return psdCount;
  }

  const dataUrl = await fileToDataURL(file);
  let dim: { w: number; h: number };
  try {
    dim = await loadImage(dataUrl);
  } catch {
    // Fallback: usar dimensiones 512 si no se pudo decodificar inline (ej. PSD no soportada)
    dim = { w: 512, h: 512 };
  }

  // Escala para que el lado largo no supere maxEdge en unidades de mundo (asume 1px mundo ~= 1px imagen).
  const scale = Math.min(1, maxEdge / Math.max(dim.w, dim.h, 1));
  const w = Math.max(1, Math.round(dim.w * scale));
  const h = Math.max(1, Math.round(dim.h * scale));
  const x = Math.round(viewCenter.x - w / 2);
  const y = Math.round(viewCenter.y - h / 2);
  const name = file.name.replace(/\.[^.]+$/, "") || "Imagen";
  // Re-escala el dataURL si se redujo? Mantener dataURL original; el drawImage escalará al w/h de capa.
  doc.addImageLayer(name, dataUrl, x, y, w, h);
  return 1;
}

async function tryImportPsdByLayers(
  file: File,
  doc: SceneDocument,
  viewCenter: { x: number; y: number },
  maxEdge: number,
): Promise<number> {
  // ag-psd es opcional y no está en el bundle. Se oculta el especificador a
  // Vite con Function+join para que el dev server no intente resolverlo ni
  // muestre overlay al hacer Ctrl+V con cualquier imagen; si no está
  // instalado, hay fallback a raster único.
  let agPsd: unknown;
  try {
    const spec = ["ag", "psd"].join("-");
    const dynImport = Function("s", "return import(s)") as (s: string) => Promise<unknown>;
    agPsd = await dynImport(spec);
  } catch {
    return 0;
  }
  const mod = agPsd as { readPsd?: (buf: ArrayBuffer) => unknown; initializeCanvas?: (c: HTMLCanvasElement) => void };
  if (!mod.readPsd) return 0;
  const buf = await file.arrayBuffer();
  let psd: unknown;
  try {
    psd = mod.readPsd(buf);
  } catch {
    return 0;
  }
  const psdObj = psd as {
    width?: number;
    height?: number;
    children?: Array<{
      name?: string;
      canvas?: HTMLCanvasElement;
      left?: number;
      top?: number;
      hidden?: boolean;
    }>;
  };
  const children = psdObj.children;
  if (!children || children.length === 0) return 0;

  // En ag-psd, cada child puede tener .canvas ya renderizado (requiere canvas polyfill en Node, pero en browser funciona).
  // En web, ag-psd expone canvas por capa si se llamó initializeCanvas.
  // Intentar componer cada capa visible como ImageLayer.
  let imported = 0;
  const baseW = psdObj.width ?? 0;
  const baseH = psdObj.height ?? 0;
  const scale = Math.min(1, maxEdge / Math.max(baseW, baseH, 1));

  for (const child of children) {
    if (child.hidden) continue;
    const canvas: HTMLCanvasElement | undefined = child.canvas;
    if (!canvas) continue;
    // Recorta canvas a contenido? Usar canvas tal cual.
    const dataUrl = canvas.toDataURL("image/png");
    const x = Math.round(viewCenter.x - (baseW * scale) / 2 + (child.left ?? 0) * scale);
    const y = Math.round(viewCenter.y - (baseH * scale) / 2 + (child.top ?? 0) * scale);
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    const name = child.name?.trim() || `Capa ${imported + 1}`;
    doc.addImageLayer(name, dataUrl, x, y, w, h);
    imported++;
  }
  return imported;
}

export async function importImageFromBlob(
  blob: Blob,
  name: string,
  doc: SceneDocument,
  viewCenter: { x: number; y: number },
): Promise<number> {
  const file = new File([blob], name, { type: blob.type || "image/png" });
  return importImageFile(file, doc, viewCenter);
}
