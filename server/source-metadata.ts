/**
 * Portable source-file fingerprint.
 *
 * On exFAT (including some FUSE implementations) st_ino may be synthesized
 * from a transient in-memory inode. It can change after the directory scan
 * even if the bytes and metadata have not changed. Do not use st_ino alone
 * to declare that a source file was modified.
 *
 * Keep the device, size and modification time checks. For a MOVE, this check
 * is only a cheap first guard: the engine separately hashes the complete
 * source and published destination with SHA-256 before unlinking the source.
 */
export interface SourceMetadata {
  size: number;
  mtimeMs: number;
  dev: number;
}

export function sourceMetadataMatches(expected: SourceMetadata, actual: SourceMetadata): boolean {
  return actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.dev === expected.dev;
}

/** Precise diagnostics for real changes; never report ino drift as corruption. */
export function changedSourceMetadata(expected: SourceMetadata, actual: SourceMetadata): string[] {
  const differences: string[] = [];
  if (expected.size !== actual.size) differences.push('taille');
  if (expected.mtimeMs !== actual.mtimeMs) differences.push('date de modification');
  if (expected.dev !== actual.dev) differences.push('volume');
  return differences;
}
