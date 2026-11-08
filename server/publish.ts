import { constants } from 'node:fs';
import { copyFile, link } from 'node:fs/promises';

/** A hard link publishes an already completed temporary file atomically. */
const unsupportedHardlinkCodes = new Set(['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EXDEV']);

/**
 * Publish a temporary file without ever overwriting a final filename.
 *
 * Some NAS USB filesystems do not support hard links, returning EPERM.
 * COPYFILE_EXCL is the no-overwrite fallback. It does copy the file again,
 * and the destination may be briefly visible before the fallback completes.
 * Node attempts to delete the destination on a copy error.
 */
export async function publishWithoutOverwrite(
  temporary: string,
  destination: string,
  createLink: typeof link = link,
  copyExclusively: typeof copyFile = copyFile
): Promise<'linked' | 'copied'> {
  try {
    await createLink(temporary, destination);
    return 'linked';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !unsupportedHardlinkCodes.has(code)) throw error;
    // COPYFILE_EXCL ensures that even a racing writer's file is never replaced.
    // EEXIST from either the link or the exclusive copy is NOT treated as success.
    await copyExclusively(temporary, destination, constants.COPYFILE_EXCL);
    return 'copied';
  }
}
