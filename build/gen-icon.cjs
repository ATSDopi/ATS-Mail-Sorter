// Génère l'icône de l'app : tuile arrondie en dégradé indigo→cyan,
// enveloppe blanche au centre, étincelle en haut à droite.
// Rendu raster maison (SDF + supersampling 2x) — zéro dépendance.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- Couleurs ---
const ACCENT = [91, 140, 255];    // #5b8cff indigo
const ACCENT2 = [56, 189, 248];   // #38bdf8 cyan
const WHITE = [245, 248, 255];
const SPARK = [140, 220, 255];

// --- SDF helpers ---
function sdRoundRect(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x - cx) - (w / 2 - r);
  const dy = Math.abs(y - cy) - (h / 2 - r);
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function sdSegment(x, y, x1, y1, x2, y2) {
  const px = x2 - x1, py = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * px + (y - y1) * py) / (px * px + py * py)));
  return Math.hypot(x - (x1 + px * t), y - (y1 + py * t));
}

function sdDiamond(x, y, cx, cy, w, h) {
  return Math.abs(x - cx) / (w / 2) + Math.abs(y - cy) / (h / 2) - 1;
}

// Mélange linéaire.
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Rend un pixel RGBA à la position normalisée [0,1]². */
function shade(u, v, S) {
  // Fond : tuile arrondie, dégradé diagonal accent → accent2.
  const cornerR = 0.22; // rayon des coins (fraction de S)
  const dTile = sdRoundRect(u, v, 0.5, 0.5, 1, 1, cornerR);
  if (dTile > 0) return [0, 0, 0, 0];

  const g = Math.min(1, Math.max(0, (u + v) / 2));
  let rgb = mix(ACCENT, ACCENT2, g);

  // Léger vignettage haut → plus lumineux en haut.
  rgb = mix(rgb, [255, 255, 255], Math.max(0, 0.22 - v * 0.28));

  // Ombre portée interne basse pour la profondeur.
  const depth = Math.max(0, v - 0.62) * 0.30;
  rgb = mix(rgb, [10, 20, 60], Math.min(0.35, depth));

  const stroke = 0.052; // épaisseur des traits (fraction de S)

  // Enveloppe : corps arrondi + rabat en V.
  const ex1 = 0.22, ex2 = 0.78, ey1 = 0.34, ey2 = 0.70;
  const ecx = (ex1 + ex2) / 2, ecy = (ey1 + ey2) / 2;
  const ew = ex2 - ex1, eh = ey2 - ey1;
  const dBody = Math.abs(sdRoundRect(u, v, ecx, ecy, ew, eh, 0.055) ) ;
  const dFlap = Math.min(
    sdSegment(u, v, ex1 + 0.01, ey1 + 0.02, ecx, ecy + 0.035),
    sdSegment(u, v, ecx, ecy + 0.035, ex2 - 0.01, ey1 + 0.02)
  );
  const dEnvelope = Math.min(dBody, dFlap) - stroke / 2;

  // Étincelle : deux losanges croisés (vertical + horizontal).
  const sx = 0.755, sy = 0.235;
  const dSpark = Math.min(
    sdDiamond(u, v, sx, sy, 0.085, 0.20),
    sdDiamond(u, v, sx, sy, 0.20, 0.075)
  );

  if (dSpark <= 0) rgb = mix(rgb, SPARK, 0.92);
  if (dEnvelope <= 0) rgb = mix(rgb, WHITE, 0.95);

  return [rgb[0], rgb[1], rgb[2], 255];
}

function makePNG(size) {
  const SS = 2; // supersampling
  const w = size, h = size;
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / w;
          const v = (y + (sy + 0.5) / SS) / h;
          const c = shade(u, v, size);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = SS * SS;
      const i = (y * w + x) * 4;
      px[i] = r / n; px[i + 1] = g / n; px[i + 2] = b / n; px[i + 3] = a / n;
    }
  }

  // Encode PNG.
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const comp = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  function crc(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc(Buffer.concat([tb, data])), 0);
    return Buffer.concat([len, tb, data, cb]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', comp), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(s => makePNG(s));
fs.writeFileSync(path.join(__dirname, 'icon.png'), pngs[pngs.length - 1]);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const parts = [header];
let offset = 6 + sizes.length * 16;
for (let i = 0; i < sizes.length; i++) {
  const e = Buffer.alloc(16);
  e[0] = sizes[i] >= 256 ? 0 : sizes[i]; e[1] = sizes[i] >= 256 ? 0 : sizes[i];
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  parts.push(e); offset += pngs[i].length;
}
for (const p of pngs) parts.push(p);
const ico = Buffer.concat(parts);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
console.log('OK icon.ico:', ico.length, 'bytes, icon.png:', pngs[pngs.length - 1].length, 'bytes');
