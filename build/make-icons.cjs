/**
 * Gera build/icon.ico com ENTRADAS BMP REais (DIB 32bpp BGRA, bottom-up,
 * máscara AND zerada) nos tamanhos 16/24/32/48/64/128/256 — o formato que o
 * Windows (taskbar/Explorer) e o Electron carregam com garantia. ICOs com PNG
 * embutido podem ser ignorados pela taskbar.
 * Uso: node build/make-icons.cjs (depende do sharp, devDependency).
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function dibFromRgba(rgba, width, height) {
  const maskRowBytes = Math.ceil(width / 8 / 4) * 4; // 1bpp, alinhado a 4 bytes
  const maskSize = maskRowBytes * height;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // biSize
  header.writeInt32LE(width, 4);        // biWidth
  header.writeInt32LE(height * 2, 8);   // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12);           // biPlanes
  header.writeUInt16LE(32, 14);          // biBitCount
  header.writeUInt32LE(0, 16);           // BI_RGB
  header.writeUInt32LE(width * height * 4 + maskSize, 20); // biSizeImage
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4; // bottom-up
    const dstRow = y * width * 4;
    for (let x = 0; x < width; x++) {
      const src = srcRow + x * 4;
      const dst = dstRow + x * 4;
      pixels[dst] = rgba[src + 2];      // B
      pixels[dst + 1] = rgba[src + 1];  // G
      pixels[dst + 2] = rgba[src];      // R
      pixels[dst + 3] = rgba[src + 3];  // A
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(maskSize)]);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const logo = path.join(root, 'src/renderer/assets/brand/logo.png');
  const images = [];
  for (const size of SIZES) {
    const { data } = await sharp(logo)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    images.push({ size, dib: dibFromRgba(data, size, size) });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  const blobs = [];
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.dib.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.dib.length;
    entries.push(entry);
    blobs.push(image.dib);
  }
  const ico = Buffer.concat([header, ...entries, ...blobs]);
  fs.writeFileSync(path.join(root, 'build/icon.ico'), ico);
  console.log(`icon.ico OK: ${ico.length} bytes, ${images.length} tamanhos (BMP real)`);
})();
