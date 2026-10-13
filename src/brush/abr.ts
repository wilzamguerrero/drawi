/**
 * Lector de archivos `.abr` de Photoshop — puntas muestreadas (sampled brushes).
 *
 * Soporta:
 *  - v1 / v2 : lista plana tipo+size (GIMP compatible)
 *  - v6  (CS / CC) subversión 1 y 2 : secciones 8BIM/samp con UUID + cabecera fija 47/301
 *  - v10 (CC moderno) subversión 1,2 y variantes : misma estructura pero cabecera variable
 *
 * La referencia estructural es MorrowShore/PSBrushExtract (AGPL-3.0) y
 * Pawel-9215/abr-to-krita (MIT) — ambos verificados contra .abr reales.
 * Este parser es implementación propia en TS, no copia de su código Python.
 *
 * Solo se extrae la punta (bitmap gris -> alfa) y spacing. Las dinámicas viven en
 * el descriptor "desc" y se dejarán para la fase Krita/Procreate; por ahora la
 * punta es lo que hace que "no se ve nada" pase a "se ve".
 */

export interface AbrBrush {
  name: string;
  width: number;
  height: number;
  coverage: Uint8ClampedArray; // 255 - gris
  spacing: number; // 0.01..2
}

class Reader {
  pos = 0;
  v: DataView;
  constructor(public buf: ArrayBuffer) { this.v = new DataView(buf); }
  get length(): number { return this.v.byteLength; }
  get eof(): boolean { return this.pos >= this.v.byteLength; }
  u8(): number { return this.v.getUint8(this.pos++); }
  u16(): number { const n = this.v.getUint16(this.pos); this.pos += 2; return n; }
  s16(): number { const n = this.v.getInt16(this.pos); this.pos += 2; return n; }
  u32(): number { const n = this.v.getUint32(this.pos); this.pos += 4; return n; }
  s32(): number { const n = this.v.getInt32(this.pos); this.pos += 4; return n; }
  tag(): string { let s = ""; for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8()); return s; }
  bytes(n: number): Uint8Array { const a = new Uint8Array(this.buf, this.pos, n); this.pos += n; return a; }
}

const pad4 = (n: number): number => n + ((4 - (n % 4)) % 4);

/** PackBits por scanline como PSD/ABR: tabla u16 × height. */
function readBitmap(r: Reader, width: number, height: number, depth: number, compression: number): Uint8ClampedArray {
  const n = width * height;
  // 32-bit (RGBA 8.8.8.8): el alfa es la cobertura directamente
  if (depth === 32) {
    const cov = new Uint8ClampedArray(n);
    if (compression === 0) {
      for (let i = 0; i < n; i++) { r.u8(); r.u8(); r.u8(); cov[i] = r.u8(); }
    } else {
      // RLE de 32-bit en ABR es raro; fallback: lee scanlines como 8-bit ×4
      const counts: number[] = [];
      for (let y = 0; y < height; y++) counts.push(r.u16());
      for (let y = 0; y < height; y++) {
        const end = r.pos + counts[y];
        // decodifica fila como bytes planos
        const tmp: number[] = [];
        while (r.pos < end && tmp.length < width * 4) {
          const h = r.u8();
          if (h < 128) { const run = h + 1; for (let k = 0; k < run && tmp.length < width * 4; k++) tmp.push(r.u8()); }
          else if (h > 128) { const run = 257 - h; const val = r.u8(); for (let k = 0; k < run && tmp.length < width * 4; k++) tmp.push(val); }
        }
        r.pos = end;
        for (let xi = 0; xi < width; xi++) cov[y * width + xi] = tmp[xi * 4 + 3] ?? 0;
      }
    }
    // auto-invierte si la mayoría es opaca (fondo mal asumido)
    let opaque = 0; for (let i = 0; i < n; i++) if (cov[i] > 20) opaque++;
    if (opaque > n * 0.6) { for (let i = 0; i < n; i++) cov[i] = 255 - cov[i]; }
    return cov;
  }
  const gray = new Uint8ClampedArray(n);
  const bytes = depth >> 3; // 1 o 2, para 16-bit se ignora byte bajo
  // depth 1 es 1-bit empaquetado — no se ve en .abr de pincel, se expande a 8-bit
  if (depth === 1) {
    if (compression === 0) {
      let bitPos = 0;
      for (let i = 0; i < n; i++) {
        if (bitPos % 8 === 0) {
          const byte = r.u8();
          for (let b = 0; b < 8 && i < n; b++, i++) gray[i] = (byte & (0x80 >> b)) ? 0 : 255;
          i--;
        }
        bitPos++;
      }
      const cov = new Uint8ClampedArray(n);
      for (let i = 0; i < n; i++) cov[i] = 255 - gray[i];
      return cov;
    }
    const cov = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) cov[i] = 0;
    return cov;
  }
  if (compression === 0) {
    for (let i = 0; i < n; i++) { gray[i] = r.u8(); if (bytes === 2) r.u8(); if (bytes === 4) { r.u8(); r.u8(); r.u8(); } }
  } else {
    const counts: number[] = [];
    for (let y = 0; y < height; y++) counts.push(r.u16());
    for (let y = 0; y < height; y++) {
      const end = r.pos + counts[y];
      let x = 0;
      while (x < width && r.pos < end) {
        const h = r.u8();
        if (h < 128) {
          const run = h + 1;
          for (let k = 0; k < run && x < width; k++) { gray[y * width + x++] = r.u8(); if (bytes === 2) r.u8(); if (bytes === 4) { r.u8(); r.u8(); r.u8(); } }
        } else if (h > 128) {
          const run = 257 - h;
          const val = r.u8(); if (bytes === 2) r.u8(); if (bytes === 4) { r.u8(); r.u8(); r.u8(); }
          for (let k = 0; k < run && x < width; k++) gray[y * width + x++] = val;
        }
      }
      r.pos = end;
    }
  }
  // Photoshop: punta negra sobre blanco (255 - gris). Algunos .abr CC modernos
  // vienen invertidos (blanco sobre negro) — detecta fondo por mayoría.
  let opaque = 0;
  for (let i = 0; i < n; i++) if (255 - gray[i] > 20) opaque++;
  const invert = opaque > n * 0.6;
  const tmp = new Uint8ClampedArray(n);
  if (invert) { for (let i = 0; i < n; i++) tmp[i] = gray[i]; }
  else { for (let i = 0; i < n; i++) tmp[i] = 255 - gray[i]; }
  // Normaliza halo: recorta caja a contenido real (sin papel) y remuestrea.
  // Si la punta llena el bitmap de borde a borde, el fondo negro que ves
  // es el rect del bitmap; al recortar desaparece el cuadro.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (tmp[y * width + x]! > 12) {
    if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  if (maxX < 0) { // toda vacía: deja como estaba
    const cov0 = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) cov0[i] = tmp[i]!;
    return cov0;
  }
  const pad = 1;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  // Si el recorte apenas cambia (<4px), evita alocar de más y devuelve tal cual
  if (cw === width && ch === height) {
    const cov1 = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) cov1[i] = tmp[i]!;
    return cov1;
  }
  // Extrae subrect y lo devuelve como bitmap nueva dimensión — el caller
  // necesita saber el tamaño recortado. Para no cambiar interfaz, expandimos
  // el coverage al subrect y ajustamos width/height en el brush en readSampSection.
  // Aquí marcamos recorte via propiedad oculta; parseo lo aplicará.
  // En su lugar, devuelve el recorte directamente y deja que caller lo adopte.
  // Truco: devuelve cov recortado; el parser lo detectará por n != w*h original.
  const cov = new Uint8ClampedArray(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) cov[y * cw + x] = tmp[(minY + y) * width + (minX + x)]!;
  // Señala dimensiones recortadas via closure global temporal
  (cov as unknown as { _cw: number; _ch: number })._cw = cw;
  (cov as unknown as { _ch: number })._ch = ch;
  return cov;
}

function readUcs2(r: Reader): string {
  const chars = r.u32();
  let s = "";
  for (let i = 0; i < chars; i++) { const c = r.u16(); if (c !== 0) s += String.fromCharCode(c); }
  return s;
}

function clampSpacing(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 0.1;
  return Math.min(2, Math.max(0.01, s));
}

// ---- v1 / v2 ----

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
        r.u32();
        const spacing = r.u16();
        const name = version === 2 ? readUcs2(r) : `Pincel ${i + 1}`;
        r.u8();
        r.u16(); r.u16(); r.u16(); r.u16();
        const top = r.s32(); const left = r.s32(); const bottom = r.s32(); const right = r.s32();
        const depth = r.u16(); const compression = r.u8();
        const width = right - left; const height = bottom - top;
        if (width > 0 && height > 0 && width <= 8192 && height <= 8192) {
          const coverage = readBitmap(r, width, height, depth, compression);
          out.push({ name: name || `Pincel ${i + 1}`, width, height, coverage, spacing: clampSpacing(spacing / 100) });
        }
      }
    } catch { /* salta punta */ }
    r.pos = next;
  }
  return out;
}

// ---- v6 / v10 ----

const HEADER_SKIP: Record<number, number> = { 1: 47, 2: 301 };

function readSampSection(r: Reader, sectionEnd: number, subversion: number): AbrBrush[] {
  const out: AbrBrush[] = [];
  let index = 1;
  const knownSkip = HEADER_SKIP[subversion];
  while (r.pos + 4 <= sectionEnd) {
    const entryLen = r.u32();
    if (entryLen <= 0 || entryLen > 50_000_000) { r.pos = sectionEnd; break; }
    const entryStart = r.pos;
    const nextEntry = entryStart + pad4(entryLen);
    if (nextEntry > sectionEnd + 4) { r.pos = sectionEnd; break; }
    try {
      if (r.pos >= nextEntry) { r.pos = nextEntry; continue; }
      const uuidLen = r.u8();
      if (uuidLen > 64) throw new Error("uuid largo");
      if (r.pos + uuidLen > nextEntry) throw new Error("uuid fuera");
      const uuidBytes = r.bytes(uuidLen);
      void uuidBytes;
      // Salto fijo que incluye el UUID y la cabecera de descriptor
      if (knownSkip !== undefined) {
        // Pawel verifica: entryStart + skip es el inicio del rect
        r.pos = entryStart + knownSkip;
      } else {
        // Subversión desconocida (v10+): busca el rect por heurística en los próximos 600 bytes
        let found = false;
        const searchEnd = Math.min(nextEntry - 17, entryStart + 600);
        for (let off = r.pos; off <= searchEnd; off++) {
          r.pos = off;
          try {
            const top = r.v.getInt32(r.pos);
            const left = r.v.getInt32(r.pos + 4);
            const bottom = r.v.getInt32(r.pos + 8);
            const right = r.v.getInt32(r.pos + 12);
            const depth = r.v.getUint16(r.pos + 16);
            const w = right - left, h = bottom - top;
            if (w > 0 && h > 0 && w <= 8192 && h <= 8192 && (depth === 8 || depth === 16 || depth === 1 || depth === 32) &&
                top >= -8192 && left >= -8192 && bottom <= 8192 && right <= 8192) {
              found = true; break;
            }
          } catch { /* sigue */ }
        }
        if (!found) { r.pos = nextEntry; continue; }
      }
      if (r.pos + 17 > nextEntry) { r.pos = nextEntry; continue; }
      const top = r.s32(); const left = r.s32(); const bottom = r.s32(); const right = r.s32();
      const depth = r.u16(); const compress = r.u8();
      const width = right - left, height = bottom - top;
      if (width <= 0 || height <= 0 || width > 8192 || height > 8192) { r.pos = nextEntry; continue; }
      if (depth !== 8 && depth !== 16 && depth !== 1 && depth !== 32) { r.pos = nextEntry; continue; }
      const coverage = readBitmap(r, width, height, depth === 32 ? 32 : depth, compress);
      // readBitmap puede devolver un bitmap recortado (sin fondo) con dims en _cw/_ch
      const cw = (coverage as unknown as { _cw?: number })._cw;
      const ch = (coverage as unknown as { _ch?: number })._ch;
      if (cw !== undefined && ch !== undefined) {
        out.push({ name: `Pincel ${index++}`, width: cw, height: ch, coverage, spacing: 0.25 });
      } else {
        out.push({ name: `Pincel ${index++}`, width, height, coverage, spacing: 0.25 });
      }
    } catch { /* salta */ }
    r.pos = nextEntry;
    if (r.pos <= entryStart) break;
  }
  return out;
}

function parseV6(r: Reader, subversion: number): AbrBrush[] {
  const out: AbrBrush[] = [];
  while (r.pos + 8 <= r.length) {
    if (r.eof) break;
    const tagPos = r.pos;
    let tag: string;
    try { tag = r.tag(); } catch { break; }
    if (tag !== "8BIM") { r.pos = tagPos + 1; // escanea byte a byte hasta 8BIM
      // busca siguiente 8BIM para no perder la sección
      const buf = new Uint8Array(r.buf);
      let found = -1;
      for (let i = r.pos; i < buf.length - 3; i++) if (buf[i]===0x38 && buf[i+1]===0x42 && buf[i+2]===0x49 && buf[i+3]===0x4d) { found=i; break; }
      if (found === -1) break;
      r.pos = found; continue;
    }
    if (r.pos + 8 > r.length) break;
    const key = r.tag();
    const len = r.u32();
    const sectionEnd = Math.min(r.length, r.pos + len);
    if (key === "samp") {
      out.push(...readSampSection(r, sectionEnd, subversion));
    }
    r.pos = sectionEnd;
    // sección acolchada a par si len impar (como PSD)
    if ((len % 2) !== 0 && r.pos < r.length) r.pos += 1;
  }
  return out;
}

function bruteScan(buf: ArrayBuffer): AbrBrush[] {
  // Último recurso: busca "8BIMsamp" y parsea como samp
  const u8 = new Uint8Array(buf);
  const needle = [0x38,0x42,0x49,0x4d,0x73,0x61,0x6d,0x70];
  const out: AbrBrush[] = [];
  for (let i = 0; i < u8.length - 16; i++) {
    let hit = true; for (let k=0;k<needle.length;k++) if (u8[i+k]!==needle[k]) { hit=false; break; }
    if (!hit) continue;
    const lenPos = i + 8; if (lenPos+4 > u8.length) continue;
    const len = new DataView(buf).getUint32(lenPos);
    if (len <= 0 || len > 30_000_000) continue;
    const sectionEnd = Math.min(u8.length, lenPos+4+len);
    const r = new Reader(buf); r.pos = lenPos+4;
    try { out.push(...readSampSection(r, sectionEnd, 2)); } catch {}
    if (out.length > 0) break; // con uno basta; readSampSection ya extrae todos de esa sección
  }
  return out;
}

/** API principal: devuelve puntas visibles (al menos un píxel no blanco). */
export function parseAbr(buf: ArrayBuffer): AbrBrush[] {
  if (buf.byteLength < 4) return [];
  const r = new Reader(buf);
  const version = r.u16();
  const second = r.u16();
  const posAfterHeader = r.pos;
  try {
    if (version === 1 || version === 2) {
      r.pos = 2; // rebobina para que parseV12 lea count
      const a = parseV12(r, version);
      if (a.length > 0) return filterVisible(a);
    }
    // Incluye v9 (9.2 = INK 40 pack) y cualquier otra versión: estructura es 8BIM/samp
    if (version === 6 || version === 9 || version === 10 || version === 12 || version === 13) {
      r.pos = posAfterHeader;
      const a = parseV6(r, second);
      if (a.length > 0) return filterVisible(a);
      const b = bruteScan(buf);
      if (b.length > 0) return filterVisible(b);
      return filterVisible(a);
    }
    // Versión desconocida: intenta como v6
    r.pos = posAfterHeader;
    const a = parseV6(r, second);
    if (a.length > 0) return filterVisible(a);
    return filterVisible(bruteScan(buf));
  } catch {
    try { const b = bruteScan(buf); if (b.length>0) return filterVisible(b); } catch {}
  }
  return filterVisible(bruteScan(buf));
}

function filterVisible(brushes: AbrBrush[]): AbrBrush[] {
  // Una punta toda blanca (coverage todo 0) es invisible en el dock; se filtra
  return brushes.filter(b => {
    let mx = 0; for (let i=0;i<b.coverage.length;i++) if (b.coverage[i] > mx) mx = b.coverage[i];
    return mx > 8; // al menos algo de tinta
  });
}

export function abrToMaskCanvas(b: AbrBrush): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = b.width; c.height = b.height;
  const g = c.getContext("2d");
  if (!g) throw new Error("Canvas 2D no disponible");
  const img = g.createImageData(b.width, b.height);
  for (let i = 0; i < b.coverage.length; i++) {
    const o = i*4; img.data[o]=0; img.data[o+1]=0; img.data[o+2]=0; img.data[o+3]=b.coverage[i];
  }
  g.putImageData(img, 0, 0);
  return c;
}
