import { sha256 } from '@noble/hashes/sha2.js';
self.onmessage = async (event: MessageEvent<Blob>) => {
  try {
    const blob = event.data,
      digest = sha256.create();
    for (let offset = 0; offset < blob.size; offset += 4 * 1024 * 1024) {
      digest.update(
        new Uint8Array(await blob.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer()),
      );
      self.postMessage({ progress: Math.min(blob.size, offset + 4 * 1024 * 1024) / blob.size });
    }
    self.postMessage({
      hash: Array.from(digest.digest())
        .map((n) => n.toString(16).padStart(2, '0'))
        .join(''),
    });
  } catch {
    self.postMessage({ error: '文件校验失败，请重新选择文件' });
  }
};
