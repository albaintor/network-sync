import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, link, opendir, rename, rm, stat, utimes, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Roots, RunProgress, SyncJob } from './models.js';
import { destinationRootFor, ensureDestinationDirectory, isInside, validateJobPaths, ValidationError } from './security.js';

interface FileTask {
  sourceRoot: string;
  sourcePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

interface Occupant {
  size: number;
  path: string;
  virtual?: FileTask;
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Synchronisation annulée.');
}

async function* walk(directory: string, base: string, signal: AbortSignal): AsyncGenerator<FileTask> {
  aborted(signal);
  const handle = await opendir(directory);
  for await (const entry of handle) {
    aborted(signal);
    // Never follow symlinks, whether they point to a file or directory.
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(filename, base, signal);
    } else if (entry.isFile()) {
      const info = await lstat(filename);
      if (!info.isFile()) continue;
      yield {
        sourceRoot: base,
        sourcePath: filename,
        relativePath: path.relative(base, filename),
        size: info.size,
        mtimeMs: info.mtimeMs
      };
    }
  }
}

async function sha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function sameFile(task: FileTask, occupant: Occupant, mode: SyncJob['compareMode']): Promise<boolean> {
  if (task.size !== occupant.size) return false;
  if (mode === 'size') return true;
  return (await sha256(task.sourcePath)) === (await sha256(occupant.virtual?.sourcePath ?? occupant.path));
}

function renamedPath(original: string, unique: string, number: number): string {
  const parsed = path.parse(original);
  return path.join(parsed.dir, parsed.name + '__' + unique + (number > 1 ? '_' + number : '') + parsed.ext);
}

async function occupantAt(filename: string, planned: Map<string, FileTask>): Promise<Occupant | null> {
  const virtual = planned.get(filename);
  if (virtual) return { size: virtual.size, path: filename, virtual };
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new ValidationError('Conflit avec un dossier ou lien symbolique : ' + filename);
    return { size: info.size, path: filename };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Copy to a sibling temp file and publish atomically. Never overwrite when a
// rename/normal copy was intended. A failed or cancelled copy leaves no partial target.
async function copyAtomic(task: FileTask, target: string, overwrite: boolean, signal: AbortSignal): Promise<void> {
  const temp = path.join(path.dirname(target), '.network-sync-' + randomUUID() + '.tmp');
  try {
    aborted(signal);
    const canonical = await realpath(task.sourcePath);
    if (!isInside(await realpath(task.sourceRoot), canonical)) {
      throw new ValidationError('Le fichier source a quitté la racine source.');
    }
    const before = await lstat(task.sourcePath);
    if (!before.isFile()) throw new ValidationError('Source non régulière : ' + task.sourcePath);
    await pipeline(createReadStream(task.sourcePath), createWriteStream(temp, { flags: 'wx', mode: 0o644 }), { signal });
    const after = await lstat(task.sourcePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Le fichier source a été modifié pendant sa copie.');
    }
    await utimes(temp, before.atime, before.mtime);
    aborted(signal);
    if (overwrite) {
      // The user explicitly selected overwrite; still refuse symlinks.
      const current = await occupantAt(target, new Map());
      if (current === null) {
        await link(temp, target);
      } else {
        await rename(temp, target);
        return;
      }
    } else {
      await link(temp, target); // EEXIST protects an unexpectedly created target.
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function reportError(progress: RunProgress, error: unknown, file?: string): void {
  progress.errors++;
  if (progress.errorMessages.length < 25) {
    progress.errorMessages.push((file ? file + ' : ' : '') + (error instanceof Error ? error.message : String(error)));
  }
}

export function newProgress(job: SyncJob, dryRun: boolean): RunProgress {
  return {
    id: randomUUID(), jobId: job.id, jobName: job.name, dryRun,
    status: 'running', phase: 'scanning', startedAt: new Date().toISOString(),
    filesTotal: 0, bytesTotal: 0, processed: 0, bytesCopied: 0,
    copied: 0, skipped: 0, renamed: 0, overwritten: 0, errors: 0,
    errorMessages: [], currentFile: null
  };
}

/**
 * Merge all source directory trees at the destination root. Only copy;
 * never delete source or destination files. A dry run simulates collisions
 * between sources using a virtual target map.
 */
export async function executeSync(
  job: SyncJob,
  progress: RunProgress,
  roots: Roots,
  signal: AbortSignal,
  onUpdate: () => void = () => {}
): Promise<void> {
  try {
    await validateJobPaths(job, roots);
    const destinationRoot = await destinationRootFor(job.destination, roots);
    const tasks: FileTask[] = [];
    for (const source of job.sources) {
      for await (const task of walk(source, source, signal)) {
        tasks.push(task);
        progress.filesTotal++;
        progress.bytesTotal += task.size;
        if (tasks.length % 200 === 0) onUpdate();
      }
    }

    progress.phase = 'copying';
    onUpdate();
    const planned = new Map<string, FileTask>();
    for (const task of tasks) {
      aborted(signal);
      progress.currentFile = task.sourcePath;
      try {
        const original = path.join(job.destination, task.relativePath);
        if (!isInside(job.destination, original)) throw new ValidationError('Chemin relatif non sûr');
        await ensureDestinationDirectory(destinationRoot, path.dirname(original), !progress.dryRun);
        const existing = await occupantAt(original, planned);

        let target = original;
        let action: 'copy' | 'skip' | 'rename' | 'overwrite' = 'copy';

        if (existing) {
          if (await sameFile(task, existing, job.compareMode)) {
            action = 'skip';
          } else if (job.conflictPolicy === 'skip') {
            action = 'skip';
          } else if (job.conflictPolicy === 'overwrite') {
            action = 'overwrite';
          } else {
            const stableId = createHash('sha256').update(task.sourceRoot + '\0' + task.relativePath).digest('hex').slice(0, 10);
            let found = false;
            // Bound candidate search to avoid runaway on an abused directory.
            for (let suffix = 1; suffix <= 10000; suffix++) {
              const candidate = renamedPath(original, stableId, suffix);
              const occupant = await occupantAt(candidate, planned);
              if (!occupant) {
                target = candidate;
                action = 'rename';
                found = true;
                break;
              }
              if (await sameFile(task, occupant, job.compareMode)) {
                action = 'skip';
                found = true;
                break;
              }
            }
            if (!found) throw new Error('Trop de variantes de noms de fichiers');
          }
        }

        if (action === 'skip') {
          progress.skipped++;
        } else {
          await ensureDestinationDirectory(destinationRoot, path.dirname(target), !progress.dryRun);
          if (!progress.dryRun) await copyAtomic(task, target, action === 'overwrite', signal);
          else planned.set(target, task);
          progress.copied++;
          if (action === 'rename') progress.renamed++;
          if (action === 'overwrite') progress.overwritten++;
          if (!progress.dryRun) progress.bytesCopied += task.size;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        reportError(progress, error, task.sourcePath);
      } finally {
        progress.processed++;
        onUpdate();
      }
    }
    progress.status = progress.errors ? 'completed_with_errors' : 'completed';
  } catch (error) {
    if (signal.aborted) {
      progress.status = 'cancelled';
    } else {
      reportError(progress, error);
      progress.status = 'failed';
    }
  } finally {
    progress.phase = 'finished';
    progress.currentFile = null;
    progress.finishedAt = new Date().toISOString();
    onUpdate();
  }
}
