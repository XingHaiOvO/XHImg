import sharp from 'sharp';

// libvips can retain memory-mapped WebP inputs in its operation cache on Windows,
// preventing unlink even after toFile()/stats() completes. Upload and thumbnail
// inputs are one-shot temporary files; retaining operations provides no reuse.
sharp.cache(false);

export default sharp;
