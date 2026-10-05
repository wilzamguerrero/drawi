import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  const c = crc32(Buffer.concat([t, data]));
  crc.writeUInt32BE(c, 0);
  return Buffer.concat([len, t, data, crc]);
}
function toPNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}

// Draw helpers
function fillRect(buf, W, H, r, g, b, a = 255) {
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = a;
  }
}
function drawCircle(buf, W, H, cx, cy, rad, r, g, b) {
  const rr = rad * rad;
  for (let y = Math.max(0, Math.floor(cy - rad - 1)); y < Math.min(H, Math.ceil(cy + rad + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rad - 1)); x < Math.min(W, Math.ceil(cx + rad + 1)); x++) {
      let coverage = 0;
      // 2x2 supersampling
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const px = x + (sx + 0.5) / 2;
        const py = y + (sy + 0.5) / 2;
        const dx = px - cx, dy = py - cy;
        if (dx * dx + dy * dy <= rr) coverage += 0.25;
      }
      if (coverage === 0) continue;
      const idx = (y * W + x) * 4;
      if (coverage >= 1) {
        buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = 255;
      } else {
        // blend with existing
        const er = buf[idx], eg = buf[idx + 1], eb = buf[idx + 2];
        buf[idx] = Math.round(er * (1 - coverage) + r * coverage);
        buf[idx + 1] = Math.round(eg * (1 - coverage) + g * coverage);
        buf[idx + 2] = Math.round(eb * (1 - coverage) + b * coverage);
        buf[idx + 3] = 255;
      }
    }
  }
}

// Metaball field for app icon (like splash, but static and precise)
// We rasterize the scalar field f = sum r²/(dx²+dy²) and threshold at 1.0
function drawMetaball(buf, W, H, blobs, bgR, bgG, bgB, fgR, fgG, fgB) {
  // fill bg first
  fillRect(buf, W, H, bgR, bgG, bgB);
  const lo = 1.0 - 0.06, hi = 1.0 + 0.06, span = hi - lo;
  // we render field in one pass per pixel with AA (2x2)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      // supersample 2x2
      let cov = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const px = x + (sx + 0.5) / 2;
        const py = y + (sy + 0.5) / 2;
        let f = 0;
        for (const b of blobs) {
          const dx = px - b.x;
          const dy = py - b.y;
          f += (b.r * b.r) / (dx * dx + dy * dy + 0.0001);
        }
        let a = (f - lo) / span;
        if (a < 0) a = 0; else if (a > 1) a = 1;
        cov += a * 0.25;
      }
      if (cov <= 0) continue;
      if (cov >= 1) cov = 1;
      // coverage-based alpha blend over bg
      // For icon we want solid shape, so just lerp fg over bg
      const idx = (y * W + x) * 4;
      if (cov >= 0.999) {
        buf[idx] = fgR; buf[idx + 1] = fgG; buf[idx + 2] = fgB;
      } else {
        buf[idx] = Math.round(bgR * (1 - cov) + fgR * cov);
        buf[idx + 1] = Math.round(bgG * (1 - cov) + fgG * cov);
        buf[idx + 2] = Math.round(bgB * (1 - cov) + fgB * cov);
      }
      buf[idx + 3] = 255;
    }
  }
}

function makeIcon(size, maskable, outPath) {
  const W = size, H = size;
  const buf = Buffer.alloc(W * H * 4);
  const BG = [10, 10, 10]; // #0a0a0a
  const FG = [255, 255, 255];

  // Blob layout: replicate Zence Draw metaball but centered.
  // For maskable: add ~20% padding (scale 0.80) and keep inside safe zone.
  const s = maskable ? 0.80 : 1.0;
  const pad = maskable ? (size * 0.10) : 0; // extra inset for safe zone
  // Effective center
  const cx = W / 2, cy = H / 2 - size * 0.02 * s;

  // Radii proportional to size
  const unit = size * s;
  // Band for oval (wider than tall) like splash
  const mainR = unit * 0.11;
  const r2 = unit * 0.074;
  const r3 = unit * 0.062;
  const r4 = unit * 0.050;
  const r5 = unit * 0.038;

  // Five blobs forming a horizontal pill that frames "ZENCE" text area
  const blobs = [
    { x: cx, y: cy, r: mainR },
    { x: cx - unit * 0.11, y: cy - unit * 0.015, r: r2 },
    { x: cx + unit * 0.115, y: cy + unit * 0.01, r: r3 },
    { x: cx - unit * 0.05, y: cy + unit * 0.055, r: r4 },
    { x: cx + unit * 0.06, y: cy - unit * 0.05, r: r5 },
  ];

  // Add tiny satellite dots like favicon (top-right, bottom-left)
  // Only for non-maskable full-bleed version we keep them; for maskable keep inside
  const sat1 = { x: cx + unit * 0.22, y: cy - unit * 0.18, r: unit * 0.038 };
  const sat2 = { x: cx - unit * 0.22, y: cy + unit * 0.15, r: unit * 0.028 };
  // Include satellites as independent circles (not part of field) to keep crisp
  // But we can also just include them in field for fusion effect. We'll include in field:
  blobs.push(sat1, sat2);

  drawMetaball(buf, W, H, blobs, BG[0], BG[1], BG[2], FG[0], FG[1], FG[2]);

  // Overlay subtle text hint for 512 only (sharper): add "Z" letter inside blob via dark cutout
  // We skip text to keep icon ultra legible at small sizes.

  // Add rounded-corner safe background for maskable preview (actual file is square, OS masks)
  // No-op.

  const png = toPNG(W, H, buf);
  writeFileSync(outPath, png);
  console.log(`→ ${outPath} ${size}x${size}${maskable ? " maskable" : ""}`);
}

makeIcon(192, false, "public/icon-192.png");
makeIcon(512, false, "public/icon-512.png");
makeIcon(192, true,  "public/icon-192-maskable.png");
makeIcon(512, true,  "public/icon-512-maskable.png");
makeIcon(180, true,  "public/apple-touch-icon.png");
makeIcon(512, false, "public/icon-512-any.png"); // alias check

// Also generate favicon 32 and a crisp SVG fallback
import { writeFileSync as wf } from "node:fs";
wf("public/favicon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0a0a0a"/><circle cx="45" cy="22" r="6" fill="white"/><circle cx="18" cy="40" r="4.5" fill="white"/><circle cx="32" cy="32" r="15" fill="white"/></svg>`);
console.log("→ public/favicon.svg");
