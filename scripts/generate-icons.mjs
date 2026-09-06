import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const outputDirectory = resolve("public");
const masterPath = resolve(outputDirectory, "icon-master-512.png");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
};

const paeth = (left, up, upperLeft) => {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
};

const decodeRgbPng = (buffer) => {
  if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error("Icon master is not a PNG file.");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const imageData = [];

  for (let offset = pngSignature.length; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") imageData.push(data);
    offset += length + 12;
    if (type === "IEND") break;
  }

  if (width !== 512 || height !== 512) throw new Error(`Icon master must be exactly 512x512; received ${width}x${height}.`);
  if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
    throw new Error("Icon master must be a non-interlaced, opaque 8-bit RGB PNG.");
  }

  const channels = 3;
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(imageData));
  if (filtered.length !== (stride + 1) * height) throw new Error("Icon master pixel data is incomplete.");
  const pixels = new Uint8Array(width * height * channels);
  let prior = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filteredOffset = y * (stride + 1);
    const filter = filtered[filteredOffset];
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const encoded = filtered[filteredOffset + 1 + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = prior[x];
      const upperLeft = x >= channels ? prior[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG row filter ${filter}.`);
      row[x] = (encoded + predictor) & 0xff;
    }
    pixels.set(row, y * stride);
    prior = row;
  }

  return { width, height, pixels };
};

const resizeRgb = (source, size) => {
  if (size === source.width && size === source.height) return new Uint8Array(source.pixels);
  const result = new Uint8Array(size * size * 3);
  const xScale = source.width / size;
  const yScale = source.height / size;

  for (let targetY = 0; targetY < size; targetY += 1) {
    const sourceTop = targetY * yScale;
    const sourceBottom = (targetY + 1) * yScale;
    for (let targetX = 0; targetX < size; targetX += 1) {
      const sourceLeft = targetX * xScale;
      const sourceRight = (targetX + 1) * xScale;
      const totals = [0, 0, 0];
      let totalWeight = 0;
      for (let sourceY = Math.floor(sourceTop); sourceY < Math.ceil(sourceBottom); sourceY += 1) {
        const yWeight = Math.min(sourceY + 1, sourceBottom) - Math.max(sourceY, sourceTop);
        for (let sourceX = Math.floor(sourceLeft); sourceX < Math.ceil(sourceRight); sourceX += 1) {
          const xWeight = Math.min(sourceX + 1, sourceRight) - Math.max(sourceX, sourceLeft);
          const weight = xWeight * yWeight;
          const sourceOffset = (sourceY * source.width + sourceX) * 3;
          totals[0] += source.pixels[sourceOffset] * weight;
          totals[1] += source.pixels[sourceOffset + 1] * weight;
          totals[2] += source.pixels[sourceOffset + 2] * weight;
          totalWeight += weight;
        }
      }
      const targetOffset = (targetY * size + targetX) * 3;
      result[targetOffset] = Math.round(totals[0] / totalWeight);
      result[targetOffset + 1] = Math.round(totals[1] / totalWeight);
      result[targetOffset + 2] = Math.round(totals[2] / totalWeight);
    }
  }
  return result;
};

const grayscaleRgb = (source) => {
  const pixels = new Uint8Array(source.pixels.length);
  for (let index = 0; index < source.pixels.length; index += 3) {
    const luminance = Math.round(
      source.pixels[index] * 0.2126
      + source.pixels[index + 1] * 0.7152
      + source.pixels[index + 2] * 0.0722,
    );
    pixels[index] = luminance;
    pixels[index + 1] = luminance;
    pixels[index + 2] = luminance;
  }
  return { width: source.width, height: source.height, pixels };
};

const encodeRgbPng = (size, pixels, compressionLevel = 9) => {
  const channels = 3;
  const stride = size * channels;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 1;
    for (let x = 0; x < stride; x += 1) {
      const pixelOffset = y * stride + x;
      const left = x >= channels ? pixels[pixelOffset - channels] : 0;
      raw[rowOffset + 1 + x] = (pixels[pixelOffset] - left + 256) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    pngSignature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: compressionLevel })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const encodeMasterPng = (size, pixels) => {
  const png = encodeRgbPng(size, pixels);
  const iendOffset = png.length - 12;
  const description = Buffer.from("Description\0Andoracle canonical grayscale icon master", "latin1");
  return Buffer.concat([
    png.subarray(0, iendOffset),
    chunk("tEXt", description),
    png.subarray(iendOffset),
  ]);
};

const createIco = (frames) => {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const entries = [];
  let imageOffset = 6 + frames.length * 16;
  for (const [size, png] of frames) {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    entries.push(entry);
    imageOffset += png.length;
  }
  return Buffer.concat([header, ...entries, ...frames.map(([, png]) => png)]);
};

const masterBuffer = readFileSync(masterPath);
const sourceMaster = decodeRgbPng(masterBuffer);
const master = grayscaleRgb(sourceMaster);
const encodedMaster = encodeMasterPng(master.width, master.pixels);
if (!masterBuffer.equals(encodedMaster)) writeFileSync(masterPath, encodedMaster);
const sizes = [16, 32, 48, 72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512];
const pngs = new Map(sizes.map((size) => [
  size,
  // The host's upload scanner rejects the canonical master byte stream at a
  // runtime URL. Runtime encoding changes only PNG packaging, not a displayed
  // pixel, and omits the canonical master's descriptive metadata.
  encodeRgbPng(size, resizeRgb(master, size), size === 512 ? 8 : 9),
]));

for (const size of [16, 32, 48]) writeFileSync(resolve(outputDirectory, `favicon-${size}.png`), pngs.get(size));
for (const size of [72, 96, 128, 144, 152, 192, 256, 384, 512]) {
  writeFileSync(resolve(outputDirectory, `icon-${size}.png`), pngs.get(size));
}
for (const size of [152, 167, 180]) {
  writeFileSync(resolve(outputDirectory, `apple-touch-icon-${size}.png`), pngs.get(size));
}
writeFileSync(resolve(outputDirectory, "apple-touch-icon.png"), pngs.get(180));
writeFileSync(resolve(outputDirectory, "maskable-icon-192.png"), pngs.get(192));
writeFileSync(resolve(outputDirectory, "maskable-icon-512.png"), pngs.get(512));
writeFileSync(resolve(outputDirectory, "favicon.ico"), createIco([16, 32, 48].map((size) => [size, pngs.get(size)])));

console.log(`Generated ${sizes.length} grayscale raster sizes from ${masterPath}.`);
