import { open } from 'node:fs/promises';
import path from 'node:path';

/**
 * Apple Live Photos store their motion clip as QuickTime/ISO BMFF media.
 * The movie-level content identifier pairs a MOV with its still image; some
 * exports also contain a timed "still-image-time" metadata key.
 *
 * Inspect only the moov atom (never mdat): video payloads are deliberately
 * not decoded or scanned, and moov may be after a very large mdat.
 */
const APPLE_MARKERS = [
  Buffer.from('com.apple.quicktime.content.identifier', 'utf8'),
  Buffer.from('com.apple.quicktime.still-image-time', 'utf8')
];
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v']);
const CHUNK_BYTES = 256 * 1024;
const MAX_MOOV_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_ATOMS = 512;
const OVERLAP = Math.max(...APPLE_MARKERS.map(marker => marker.length)) - 1;

/** Returns false for non-video files and missing/malformed metadata. */
export async function isAppleLivePhotoVideo(
  filename: string, signal?: AbortSignal
): Promise<boolean> {
  if (!VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase())) return false;

  const file = await open(filename, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 8) return false;
    let position = 0;
    let atoms = 0;
    const header = Buffer.allocUnsafe(16);

    while (position + 8 <= info.size && atoms++ < MAX_TOP_LEVEL_ATOMS) {
      if (signal?.aborted) throw new Error('Synchronisation annulée.');
      const { bytesRead } = await file.read(header, 0, Math.min(16, info.size - position), position);
      if (bytesRead < 8) break;
      const boxType = header.toString('latin1', 4, 8);
      const declaredSize = header.readUInt32BE(0);
      let boxSize = declaredSize;
      let headerLength = 8;
      if (declaredSize === 1) {
        if (bytesRead < 16) break;
        const bigSize = header.readBigUInt64BE(8);
        if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
        boxSize = Number(bigSize);
        headerLength = 16;
      } else if (declaredSize === 0) {
        boxSize = info.size - position;
      }
      if (boxSize < headerLength || boxSize > info.size - position) break;

      if (boxType === 'moov') {
        // No arbitrary-sized allocations. Limit slow scans for unusually
        // large/corrupt metadata; unknown files remain eligible for copying.
        const searchEnd = position + Math.min(boxSize, MAX_MOOV_SCAN_BYTES);
        let offset = position + headerLength;
        let suffix = Buffer.alloc(0);
        const chunk = Buffer.allocUnsafe(CHUNK_BYTES);

        while (offset < searchEnd) {
          if (signal?.aborted) throw new Error('Synchronisation annulée.');
          const count = Math.min(CHUNK_BYTES, searchEnd - offset);
          const { bytesRead: got } = await file.read(chunk, 0, count, offset);
          if (!got) break;
          const data = suffix.length
            ? Buffer.concat([suffix, chunk.subarray(0, got)])
            : chunk.subarray(0, got);
          if (APPLE_MARKERS.some(marker => data.includes(marker))) return true;
          suffix = Buffer.from(data.subarray(Math.max(0, data.length - OVERLAP)));
          offset += got;
        }
      }
      position += boxSize;
    }
    return false;
  } finally {
    await file.close();
  }
}
