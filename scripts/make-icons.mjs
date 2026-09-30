/**
 * Generates the PWA icons — real PNGs, from code, with no image dependency.
 *
 * ## Why a generator instead of committed binaries nobody can regenerate
 *
 * `dist/` shipped **zero** image files (measured, PWA audit B2), so Chrome had
 * nothing to install and nothing to show in a tab. The obvious fix is to drop
 * four PNGs into `public/`. That works once and then rots: there is no way to
 * change the mark, and no way to tell a deliberate design from a screenshot.
 *
 * A PNG is a signature, three chunks and a CRC each — small enough to write here,
 * and Node's `zlib` does the only hard part. So the icons are *drawn*: a rounded
 * square, a chevron, a cursor bar, at four sizes, supersampled 4x for clean edges.
 *
 * Run: `node scripts/make-icons.mjs`
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const OUT = join(process.cwd(), "packages/baah-web/public");

/* ---------------------------------------------------------------- *
 * A minimal PNG writer: 8-bit RGBA, filter 0, one IDAT.
 * ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // Every scanline is prefixed with filter byte 0. "None" everywhere is not the
  // smallest output, and the difference is a few hundred bytes on a 512px icon
  // that is fetched once and cached forever.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const at = y * (width * 4 + 1);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- *
 * Drawing, supersampled
 * ---------------------------------------------------------------- */

const SS = 4; // supersampling factor

function canvas(size) {
  const n = size * SS;
  const buf = Buffer.alloc(n * n * 4); // transparent
  return { n, buf };
}

/** Signed distance from a point to a rounded rectangle; negative is inside. */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance from a point to a line segment, for the chevron strokes. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

function paint(target, colour, inside) {
  const { n, buf } = target;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const d = inside(x + 0.5, y + 0.5);
      if (d >= 0) continue;
      // 1px of feathering at the edge, in supersampled space.
      const alpha = Math.min(1, Math.max(0, 0.5 - d));
      const at = (y * n + x) * 4;
      const a = Math.round(colour[3] * alpha);
      if (a === 0) continue;
      // Source-over onto whatever is already there.
      const prevA = buf[at + 3] / 255;
      const outA = a + prevA * (1 - a);
      for (let c = 0; c < 3; c += 1) {
        const src = colour[c] * (a / 255);
        const dst = buf[at + c] / 255;
        buf[at + c] = Math.round(((src + dst * prevA * (1 - a / 255)) / (outA || 1)) * 255);
      }
      buf[at + 3] = Math.round(outA * 255);
    }
  }
}

/** Box-filter the supersampled buffer down to `size`. */
function downsample(target, size) {
  const { n, buf } = target;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const at = ((y * SS + sy) * n + (x * SS + sx)) * 4;
          const alpha = buf[at + 3] / 255;
          r += buf[at] * alpha;
          g += buf[at + 1] * alpha;
          b += buf[at + 2] * alpha;
          a += alpha;
        }
      }
      const samples = SS * SS;
      const at = (y * size + x) * 4;
      if (a > 0) {
        out[at] = Math.round(r / a);
        out[at + 1] = Math.round(g / a);
        out[at + 2] = Math.round(b / a);
      }
      out[at + 3] = Math.round((a / samples) * 255);
    }
  }
  return out;
}

/**
 * The mark: a rounded square (or a full bleed square for maskable), a chevron
 * suggesting a prompt, and a cursor bar suggesting a terminal.
 *
 * `inset` shrinks the glyph, because a maskable icon's outer 20% may be cropped to
 * any shape the platform likes. Drawing the mark full-size into a maskable icon is
 * the single most common way to produce one that looks fine in the manifest and
 * broken on the home screen.
 */
function drawIcon(size, { maskable = false } = {}) {
  const target = canvas(size);
  const n = target.n;
  const unit = n / size;

  const background = [29, 35, 42, 255]; // daisyUI dark `base-100`, close enough
  const glyph = [125, 211, 252, 255]; // light cyan, legible on the above

  if (maskable) {
    // Full bleed: the platform does the masking, so rounding here would show.
    paint(target, background, () => -1);
  } else {
    const radius = n * 0.22;
    paint(
      target,
      background,
      (x, y) => roundedRectDistance(x, y, n / 2, n / 2, n / 2, n / 2, radius),
    );
  }

  const scale = maskable ? 0.68 : 0.82;
  const cx = n / 2;
  const cy = n / 2;
  const half = (n * scale) / 2;
  const stroke = n * (maskable ? 0.075 : 0.09);

  // Chevron: two segments meeting at the left-middle, opening to the right.
  const tipX = cx - half * 0.45;
  const tipY = cy;
  const armX = cx + half * 0.5;
  const armY = cy - half * 0.62;
  const lowerY = cy + half * 0.62;
  paint(target, glyph, (x, y) =>
    Math.min(
      segmentDistance(x, y, tipX, tipY, armX, armY),
      segmentDistance(x, y, tipX, tipY, armX, lowerY),
    ) - stroke / 2,
  );

  // Cursor bar, under the chevron — the underscore of a shell prompt.
  const barY = cy + half * 0.82;
  paint(
    target,
    glyph,
    (x, y) => segmentDistance(x, y, cx - half * 0.5, barY, cx + half * 0.55, barY) - stroke / 2,
  );

  void unit;
  return png(size, size, downsample(target, size));
}

/* ---------------------------------------------------------------- *
 * The favicon, which is SVG because that is what it is for
 * ---------------------------------------------------------------- */

function favicon() {
  const path = join(OUT, "favicon.svg");
  writeFileSync(
    path,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="baah">
  <rect width="64" height="64" rx="14" fill="#1d232a"/>
  <path d="M22 22 L34 32 L22 42" fill="none" stroke="#7dd3fc" stroke-width="6"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M36 44 h10" fill="none" stroke="#7dd3fc" stroke-width="6" stroke-linecap="round"/>
</svg>
`,
    "utf8",
  );
  return path;
}

mkdirSync(OUT, { recursive: true });
const written = [
  ["icon-192.png", drawIcon(192)],
  ["icon-512.png", drawIcon(512)],
  ["maskable-512.png", drawIcon(512, { maskable: true })],
];
for (const [name, bytes] of written) {
  writeFileSync(join(OUT, name), bytes);
  process.stdout.write(`make-icons: ${name}  ${bytes.length} bytes\n`);
}
// Called, not merely announced. The first version printed this line without ever
// calling `favicon()`, so the script reported a file that did not exist - which is
// the entire failure class this project keeps meeting, committed by the tool that
// was supposed to catch it.
const svg = favicon();
process.stdout.write(`make-icons: ${relative(process.cwd(), svg)}\n`);
void dirname;