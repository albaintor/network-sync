import { statfs, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Linux exFAT and FUSE filesystem type magic values. */
const EXFAT_SUPER_MAGIC = 0x2011bab0;
const FUSE_SUPER_MAGIC = 0x65735546;

export type WriteMode = 'atomic' | 'direct';

function mountPath(encoded: string): string {
  return encoded.replace(/\\([0-7]{3})/g, (_match, digits: string) =>
    String.fromCharCode(parseInt(digits, 8)));
}

function mountIsExfat(directory: string, mountinfo: string): boolean {
  let longest = -1;
  let detected = false;
  const full = path.resolve(directory);
  for (const line of mountinfo.split('\n')) {
    const [before, after] = line.split(' - ');
    if (!before || !after) continue;
    const left = before.split(' ');
    const right = after.split(' ');
    const mount = mountPath(left[4] ?? '');
    if (!mount || (full !== mount && !full.startsWith(mount.endsWith('/') ? mount : mount + '/'))) continue;
    if (mount.length < longest) continue;
    longest = mount.length;
    detected = /^(?:exfat|exfat-fuse|fuse\\.exfat(?:-fuse)?)$/i.test(right[0] ?? '');
  }
  return detected;
}

/**
 * Auto: use single-pass direct/exclusive writes only on positively identified
 * exFAT. Other formats retain atomic temporary-file publication.
 *
 * A Synology exFAT FUSE mount may report a generic "fuseblk" type. Operators
 * can explicitly set NETWORK_SYNC_WRITE_MODE=direct in that case.
 */
export async function chooseWriteMode(
  directory: string,
  preference = process.env.NETWORK_SYNC_WRITE_MODE ?? 'auto'
): Promise<WriteMode> {
  if (preference === 'direct') return 'direct';
  if (preference === 'atomic') return 'atomic';
  if (preference !== 'auto') throw new Error('NETWORK_SYNC_WRITE_MODE doit valoir auto, direct ou atomic.');
  try {
    const info = await statfs(directory);
    if (Number(info.type) === EXFAT_SUPER_MAGIC) return 'direct';
    if (Number(info.type) !== FUSE_SUPER_MAGIC) return 'atomic';
    const mounts = await readFile('/proc/self/mountinfo', 'utf8');
    return mountIsExfat(directory, mounts) ? 'direct' : 'atomic';
  } catch {
    // Unknown filesystem: prefer the established atomic path.
    return 'atomic';
  }
}

/** Exposed for fixture-based tests; does not read the actual mount table. */
export const writeModeInternals = { mountIsExfat, mountPath };
