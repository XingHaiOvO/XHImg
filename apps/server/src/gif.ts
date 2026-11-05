import { fail } from './security.js';

const invalidGif = () => fail(400, 'INVALID_IMAGE', 'GIF 数据损坏或不完整');

// Count decoded pixels without materializing them. The native decoder can silently
// substitute pixels for malformed codes, so validate each frame's LZW stream first.
function validateFrame(data: Buffer, start: number, pixels: number, colors: number) {
  const minimum = data[start]!;
  const clear = 1 << minimum;
  const end = clear + 1;
  const lengths = new Uint16Array(4096);
  let cursor = start + 1;
  let blockEnd = cursor;
  let bits = 0;
  let buffer = 0;
  let width = minimum + 1;
  let next = end + 1;
  let previous = 0;
  let decoded = 0;
  for (;;) {
    while (bits < width) {
      if (cursor === blockEnd) {
        const size = data[cursor++]!;
        if (!size) invalidGif();
        blockEnd = cursor + size;
      }
      buffer |= data[cursor++]! << bits;
      bits += 8;
    }
    const code = buffer & ((1 << width) - 1);
    buffer >>>= width;
    bits -= width;
    if (code === end) break;
    if (code === clear) {
      width = minimum + 1;
      next = end + 1;
      previous = 0;
      continue;
    }
    let length = 0;
    if (code < clear && code < colors) length = 1;
    else if (code > end && code < next) length = lengths[code]!;
    else if (code === next && previous) length = previous + 1;
    decoded += length;
    if (!length || decoded > pixels) invalidGif();
    if (previous && next < lengths.length) {
      lengths[next++] = previous + 1;
      if (width < 12 && next === 1 << width) width++;
    }
    previous = length;
  }
  if (decoded !== pixels) invalidGif();
}

export function inspectGif(data: Buffer, maxPixels: number) {
  if (data.length < 13) invalidGif();
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  if (!width || !height) invalidGif();
  const tableSize = (flags: number) => (flags & 0x80 ? 2 << (flags & 7) : 0);
  const globalColors = tableSize(data[10]!);
  let offset = 13 + globalColors * 3;
  const frames: { start: number; pixels: number; colors: number }[] = [];
  const skipBlocks = () => {
    while (offset < data.length) {
      const size = data[offset++]!;
      if (!size) return;
      offset += size;
    }
    invalidGif();
  };
  while (offset < data.length) {
    const marker = data[offset++]!;
    if (marker === 0x3b) {
      if (!frames.length) invalidGif();
      for (const frame of frames) validateFrame(data, frame.start, frame.pixels, frame.colors);
      return { width, height, pages: frames.length };
    }
    if (marker === 0x21) {
      offset++; // Extension label precedes its data sub-blocks.
      skipBlocks();
      continue;
    }
    if (marker !== 0x2c || offset + 9 > data.length) invalidGif();
    if (frames.length >= 500) fail(400, 'INVALID_IMAGE', 'GIF 最多支持 500 帧');
    if (width * height * (frames.length + 1) > maxPixels)
      fail(400, 'INVALID_IMAGE', 'GIF 所有帧的画布像素合计不能超过 4000 万');
    const left = data.readUInt16LE(offset);
    const top = data.readUInt16LE(offset + 2);
    const frameWidth = data.readUInt16LE(offset + 4);
    const frameHeight = data.readUInt16LE(offset + 6);
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height)
      invalidGif();
    const localColors = tableSize(data[offset + 8]!);
    const colors = localColors || globalColors;
    offset += 9 + localColors * 3;
    const minimum = data[offset];
    if (minimum === undefined || minimum < 2 || minimum > 8 || !colors) invalidGif();
    frames.push({ start: offset++, pixels: frameWidth * frameHeight, colors });
    skipBlocks();
  }
  return invalidGif();
}
