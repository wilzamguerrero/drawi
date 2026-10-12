/**
 * Lector de archivos `.abr` de Photoshop — solo las PUNTAS (bitmaps) y el
 * espaciado, que es lo fiable: el formato no está documentado oficialmente y las
 * dinámicas viven en un descriptor de Adobe que cambia entre versiones. Las
 * puntas muestreadas (sampled brushes), en cambio, son un bitmap de escala de
 * grises con una estructura estable desde las versiones 1/2 hasta la 6.
 *
 * Se devuelve la COBERTURA (alfa) de cada punta como bytes, sin tocar el DOM,
 * para poder probar el decodificador sin un lienzo; `abrToMaskCanvas` arma el
 * mapa de alfa cuando hay navegador.
 *
 * Convención de cobertura: en un `.abr` el bitmap es gris con el blanco como
 * fondo, así que la cobertura es `255 - gris` (lo oscuro pinta), igual que hace
 * GIMP al importar estos archivos.
 */

export interface AbrBrush {
  name: string;
  width: number;
  height: number;
  /** Cobertura (alfa) por píxel, fila por fila: `width * height` bytes. */
  coverage: Uint8ClampedArray;
  /** Separación 0..1 (fracción del diámetro). */
  spacing: number;
}

class Reader {
  pos = 0;
  private v: DataView;
  constructor(buf: ArrayBuffer) {
    this.v = new DataView(buf);
  }
  get length(): number {
    return this.v.byteLength;
  }
  get eof(): boolean {
    return this.pos >= this.v.byteLength;
  }
  u8(): number {
    return this.v.getUint8(this.pos++);
  }
  u16(): number {
    const n = this.v.getUint16(this.pos);
    this.pos += 2;
    return n;
  }
  s16(): number {
    const n = this.v.getInt16(this.pos);
    this.pos += 2;
    return n;
  }
  u32(): number {
    const n = this.v.getUint32(this.pos);
    this.pos += 4;
    return n;
  }
  s32(): number {
    const n = this.v.getInt32(this.pos);
    this.pos += 4;
    return n;
  }
  tag(): string {
    let s = "";
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8());
    return s;
  }
}

/** Decodifica un bitmap de 8 bits (crudo o PackBits por filas) a cobertura. */
function readBitmap(r: Reader, width: number, height: number, depth: number, compression: number): Uint8ClampedArray {
  const n = width * height;
  const gray = new Uint8ClampedArray(n);
  const bytes = depth >> 3; // 1 (8-bit) o 2 (16-bit)
  if (compression === 0) {
    for (let i = 0; i < n; i++) {
      gray[i] = r.u8();
      if (bytes === 2) r.u8(); // 16 bits: nos quedamos con el byte alto
    }
  } else {
    // PackBits con tabla de longitudes por fila (como PSD): u16 × height.
    const counts: number[] = [];
    for (let y = 0; y < height; y++) counts.push(r.u16());
    for (let y = 0; y < height; y++) {
      const end = r.pos + counts[y];
      let x = 0;
      while (x < width && r.pos < end) {
        const h = r.u8();
        if (h < 128) {
          const run = h + 1;
          for (let k = 0; k < run && x < width; k++) {
            gray[y * width + x++] = r.u8();
            if (bytes === 2) r.u8();
          }
        } else if (h > 128) {
          const run = 257 - h;
          const val = r.u8();
          if (bytes === 2) r.u8();
          for (let k = 0; k < run && x < width; k++) gray[y * width + x++] = val;
        }
        // h === 128: nada.
      }
      r.pos = end; // alinear por si acaso
    }
  }
  const cov = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) cov[i] = 255 - gray[i];
  return cov;
}

function readUcs2(r: Reader): string {
  const chars = r.u32();
  let s = "";
  for (let i = 0; i < chars; i++) {
    const c = r.u16();
    if (c !== 0) s += String.fromCharCode(c);
  }
  return s;
}

/** Versiones 1 y 2: lista plana de pinceles con prefijo tipo+tamaño. */
function parseV12(r: Reader, version: number): AbrBrush[] {
  const out: AbrBrush[] = [];
  const count = r.u16();
  for (let i = 0; i < count; i++) {
    if (r.eof) break;
    const type = r.u16();
    const size = r.u32();
    const next = r.pos + size;
    try {
      if (type === 2) {
        r.u32(); // misc
        const spacing = r.u16();
        const name = version === 2 ? readUcs2(r) : `Pincel ${i + 1}`;
        r.u8(); // antialiasing
        r.u16(); r.u16(); r.u16(); r.u16(); // bounds cortos
        const top = r.s32();
        const left = r.s32();
        const bottom = r.s32();
        const right = r.s32();
        const depth = r.u16();
        const compression = r.u8();
        const width = right - left;
        const height = bottom - top;
        if (width > 0 && height > 0 && width <= 8192 && height <= 8192) {
          const coverage = readBitmap(r, width, height, depth, compression);
          out.push({ name: name || `Pincel ${i + 1}`, width, height, coverage, spacing: clampSpacing(spacing / 100) });
        }
      }
    } catch {
      /* punta ilegible: se salta y se sigue con la siguiente */
    }
    r.pos = next;
  }
  return out;
}

/** Versión 6 (y 6.1/6.2): secciones 8BIM; las puntas van en la sección "samp". */
function parseV6(r: Reader): AbrBrush[] {
  const out: AbrBrush[] = [];
  r.u16(); // subversión
  while (!r.eof && r.pos + 12 <= r.length) {
    const tag = r.tag();
    if (tag !== "8BIM") break;
    const key = r.tag();
    const len = r.u32();
    const sectionEnd = r.pos + len;
    if (key === "samp") {
      let idx = 0;
      while (r.pos + 4 <= sectionEnd) {
        const brushLen = r.u32();
        let end = r.pos + brushLen;
        while (end % 4 !== 0) end++;
        try {
          r.u32(); // clave/desconocido
          const top = r.s32();
          const left = r.s32();
          const bottom = r.s32();
          const right = r.s32();
          const depth = r.u16();
          const compression = r.u8();
          const width = right - left;
          const height = bottom - top;
          if (width > 0 && height > 0 && width <= 8192 && height <= 8192 && (depth === 8 || depth === 16)) {
            const coverage = readBitmap(r, width, height, depth, compression);
            out.push({ name: `Pincel ${++idx}`, width, height, coverage, spacing: 0.25 });
          }
        } catch {
          /* salta esta punta */
        }
        r.pos = end;
      }
    }
    r.pos = sectionEnd;
  }
  return out;
}

function clampSpacing(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 0.1;
  return Math.min(2, Math.max(0.01, s));
}

/** Lee un `.abr` y devuelve sus puntas muestreadas (vacío si no hay o no se puede). */
export function parseAbr(buf: ArrayBuffer): AbrBrush[] {
  if (buf.byteLength < 4) return [];
  const r = new Reader(buf);
  const version = r.u16();
  try {
    if (version === 1 || version === 2) return parseV12(r, version);
    if (version === 6) return parseV6(r);
  } catch {
    /* archivo corrupto o formato no soportado */
  }
  return [];
}

/** Arma el mapa de ALFA (cobertura) de una punta como lienzo (solo navegador). */
export function abrToMaskCanvas(b: AbrBrush): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = b.width;
  c.height = b.height;
  const g = c.getContext("2d");
  if (!g) throw new Error("Canvas 2D no disponible");
  const img = g.createImageData(b.width, b.height);
  for (let i = 0; i < b.coverage.length; i++) {
    const o = i * 4;
    img.data[o] = 0;
    img.data[o + 1] = 0;
    img.data[o + 2] = 0;
    img.data[o + 3] = b.coverage[i];
  }
  g.putImageData(img, 0, 0);
  return c;
}
