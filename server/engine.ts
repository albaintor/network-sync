import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { lstat, opendir, rename, rm, utimes, realpath, unlink, rmdir, open } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Roots, RunProgress, SyncJob } from './models.js';
import { destinationRootFor, ensureDestinationDirectory, isInside, validateJobPaths, ValidationError } from './security.js';
import { compileFilenameRegex, matchesFileFilters } from './filters.js';
import { PauseGate } from './pause.js';
import { publishWithoutOverwrite } from './publish.js';
import { chooseWriteMode } from './write-mode.js';
import { TransferMeter } from './transfer-meter.js';

interface FileTask {
  sourceRoot: string;
  sourcePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

interface Occupant {
  size: number;
  path: string;
  virtual?: FileTask;
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Synchronisation annulée.');
}

async function* walk(
  directory: string, base: string, signal: AbortSignal, gate: PauseGate,
  job: SyncJob, regex: RegExp | null, exclude: () => void
): AsyncGenerator<FileTask> {
  await gate.wait(signal);
  const handle = await opendir(directory);
  for await (const entry of handle) {
    await gate.wait(signal);
    // Never follow symlinks, whether they point to a file or directory.
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Synology bookkeeping is not user media; do not scan/copy @eaDir thumbnails
      // or recycle bin contents, even when no extension filter is configured.
      if (entry.name.toLowerCase() === '@eadir' || entry.name.toLowerCase() === '#recycle') continue;
      yield* walk(filename, base, signal, gate, job, regex, exclude);
    } else if (entry.isFile()) {
      // Cheap name checks before lstat; size check follows once the size is known.
      if (job.extensions && !job.extensions.some(ext => entry.name.toLowerCase().endsWith('.' + ext))) {
        exclude();
        continue;
      }
      if (regex && !regex.test(entry.name)) { exclude(); continue; }
      const info = await lstat(filename);
      if (!info.isFile()) continue;
      if (!matchesFileFilters(entry.name, info.size, job, regex)) {
        exclude();
        continue;
      }
      yield {
        sourceRoot: base,
        sourcePath: filename,
        relativePath: path.relative(base, filename),
        size: info.size,
        mtimeMs: info.mtimeMs,
        dev: info.dev,
        ino: info.ino
      };
    }
  }
}

async function sha256(filename: string, signal: AbortSignal, gate: PauseGate): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { signal })) {
    await gate.wait(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function sameFile(
  task: FileTask, occupant: Occupant, mode: SyncJob['compareMode'], signal: AbortSignal, gate: PauseGate
): Promise<boolean> {
  if (task.size !== occupant.size) return false;
  if (mode === 'size') return true;
  return (await sha256(task.sourcePath, signal, gate)) ===
    (await sha256(occupant.virtual?.sourcePath ?? occupant.path, signal, gate));
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

function isUnchanged(task: FileTask, info: { size: number; mtimeMs: number; dev: number; ino: number }): boolean {
  return info.size === task.size && info.mtimeMs === task.mtimeMs &&
    info.dev === task.dev && info.ino === task.ino;
}

/**
 * A move is copy-then-delete, never rename across mounts. Only delete when the
 * source is still the scanned file and the destination is byte-for-byte equal.
 * Keep the source if publishing, verification, cancellation or deletion fails.
 */
async function removeMovedSource(
  task: FileTask, target: string, destination: string, signal: AbortSignal, gate: PauseGate
): Promise<void> {
  await gate.wait(signal);
  aborted(signal);
  const canonicalSource = await realpath(task.sourcePath);
  if (!isInside(await realpath(task.sourceRoot), canonicalSource)) {
    throw new ValidationError('Le fichier source a quitté la racine source.');
  }
  const info = await lstat(task.sourcePath);
  if (!info.isFile() || info.isSymbolicLink() || !isUnchanged(task, info)) {
    throw new Error('La source a été modifiée : suppression refusée.');
  }
  const canonicalTarget = await realpath(target);
  if (!isInside(await realpath(destination), canonicalTarget)) {
    throw new ValidationError('Le fichier cible a quitté la destination.');
  }
  const output = await lstat(target);
  if (!output.isFile() || output.isSymbolicLink() || output.size !== info.size) {
    throw new Error('Cible invalide : suppression de la source refusée.');
  }
  if (await sha256(task.sourcePath, signal, gate) !== await sha256(target, signal, gate)) {
    throw new Error('La vérification SHA-256 a échoué : source conservée.');
  }
  const outputAfter = await lstat(target);
  if (!outputAfter.isFile() || outputAfter.isSymbolicLink() ||
      outputAfter.size !== output.size || outputAfter.mtimeMs !== output.mtimeMs ||
      outputAfter.dev !== output.dev || outputAfter.ino !== output.ino) {
    throw new Error('La cible a changé après vérification : source conservée.');
  }
  await gate.wait(signal);
  aborted(signal);
  const finalInfo = await lstat(task.sourcePath);
  if (!finalInfo.isFile() || !isUnchanged(task, finalInfo)) {
    throw new Error('La source a changé après vérification : suppression refusée.');
  }
  await unlink(task.sourcePath);
  // Remove only empty descendants, never the selected source directory itself.
  let directory = path.dirname(task.sourcePath);
  while (directory !== task.sourceRoot && isInside(task.sourceRoot, directory)) {
    try { await rmdir(directory); } catch { break; }
    directory = path.dirname(directory);
  }
}

// On exFAT the temporary-file/hard-link strategy would force a second full
// copy. Create the final name exclusively (O_CREAT|O_EXCL) and stream once.
// The trade-off is that readers can see an in-progress file until completion.
// Other filesystems keep atomic temp-file + hard-link publication; explicit
// overwrites always keep temp-file + rename.
async function copyAtomic(
  task: FileTask, target: string, overwrite: boolean, signal: AbortSignal, gate: PauseGate,
  onBytes: (size: number) => void = () => {},
  onMode: (mode: 'direct' | 'atomic') => void = () => {}
): Promise<void> {
  const direct = !overwrite && await chooseWriteMode(path.dirname(target)) === 'direct';
  onMode(direct ? 'direct' : 'atomic');
  const temp = path.join(path.dirname(target), '.network-sync-' + randomUUID() + '.tmp');
  const outputPath = direct ? target : temp;
  let exclusiveHandle: Awaited<ReturnType<typeof open>> | null = null;
  let ownedFile: { dev: number; ino: number } | null = null;
  let completed = false;
  try {
    aborted(signal);
    const canonical = await realpath(task.sourcePath);
    if (!isInside(await realpath(task.sourceRoot), canonical)) {
      throw new ValidationError('Le fichier source a quitté la racine source.');
    }
    const before = await lstat(task.sourcePath);
    if (!before.isFile() || !isUnchanged(task, before)) {
      throw new ValidationError('Source modifiée depuis l’analyse : ' + task.sourcePath);
    }

    // Open the final path exclusively before streaming: an existing file is
    // never truncated, even if another writer created it after our scan.
    if (direct) {
      exclusiveHandle = await open(target, 'wx', 0o644);
      const ownedStat = await exclusiveHandle.stat();
      ownedFile = { dev: ownedStat.dev, ino: ownedStat.ino };
    }

    // Pause between stream chunks, including during long video copies.
    const pauseStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        void gate.wait(signal).then(
          () => { onBytes(chunk.length); callback(null, chunk); },
          error => callback(error instanceof Error ? error : new Error(String(error)))
        );
      }
    });
    await pipeline(
      createReadStream(task.sourcePath),
      pauseStream,
      exclusiveHandle
        ? exclusiveHandle.createWriteStream({ autoClose: false })
        : createWriteStream(temp, { flags: 'wx', mode: 0o644 }),
      { signal }
    );
    await gate.wait(signal);
    const after = await lstat(task.sourcePath);
    if (!isUnchanged(task, after)) {
      throw new Error('Le fichier source a été modifié pendant sa copie.');
    }
    await utimes(outputPath, before.atime, before.mtime);
    aborted(signal);

    if (direct) {
      completed = true;
      return;
    }
    if (overwrite) {
      // Overwriting is an explicit user choice, so atomic rename is allowed.
      const current = await occupantAt(target, new Map());
      if (current !== null) {
        await rename(temp, target);
        return;
      }
    }
    const mode = await publishWithoutOverwrite(temp, target);
    if (mode === 'copied') {
      // The hard-link fallback requires a second full copy only on filesystems
      // without hard-links that were not detected or explicitly configured.
      await utimes(target, before.atime, before.mtime).catch(() => {});
    }
  } finally {
    // On an aborted/error direct copy, remove only the file owned by this run.
    // A different inode might have been published meanwhile: never unlink it.
    if (exclusiveHandle) {
      await exclusiveHandle.close().catch(() => {});
      if (!completed && ownedFile) {
        const actual = await lstat(target).catch(() => null);
        if (actual?.isFile() && !actual.isSymbolicLink() &&
            actual.dev === ownedFile.dev && actual.ino === ownedFile.ino) {
          await unlink(target).catch(() => {});
        }
      }
    }
    if (!direct) await rm(temp, { force: true }).catch(() => {});
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
    id: randomUUID(), jobId: job.id, jobName: job.name, operation: job.operation ?? 'copy', dryRun,
    status: 'running', phase: 'scanning', startedAt: new Date().toISOString(),
    filesTotal: 0, bytesTotal: 0, processed: 0, bytesCopied: 0,
    copied: 0, moved: 0, skipped: 0, excluded: 0, renamed: 0, overwritten: 0, errors: 0,
    errorMessages: [], currentFile: null
  };
}

/**
 * Merge source directories at the destination root, optionally flattening
 * paths. Move is verified copy-then-delete; a dry run never changes files.
 * A virtual target map simulates collisions between sources.
 */
export async function executeSync(
  job: SyncJob,
  progress: RunProgress,
  roots: Roots,
  signal: AbortSignal,
  onUpdate: () => void = () => {},
  gate: PauseGate = new PauseGate()
): Promise<void> {
  let meter: TransferMeter | null = null;
  try {
    await validateJobPaths(job, roots);
    const destinationRoot = await destinationRootFor(job.destination, roots);
    const regex = compileFilenameRegex(job.filenameRegex, job.filenameRegexIgnoreCase ?? false);
    const tasks: FileTask[] = [];
    for (const source of job.sources) {
      for await (const task of walk(source, source, signal, gate, job, regex, () => {
        progress.excluded = (progress.excluded ?? 0) + 1;
      })) {
        tasks.push(task);
        progress.filesTotal++;
        progress.bytesTotal += task.size;
        if (tasks.length % 200 === 0) onUpdate();
      }
    }

    progress.phase = 'copying';
    meter = !progress.dryRun ? new TransferMeter(progress, onUpdate) : null;
    meter?.begin();
    onUpdate();
    const planned = new Map<string, FileTask>();
    for (const task of tasks) {
      await gate.wait(signal);
      progress.currentFile = task.sourcePath;
      let accountedForTask = false;
      try {
        const relativeTarget = job.layout === 'flat' ? path.basename(task.relativePath) : task.relativePath;
        const original = path.join(job.destination, relativeTarget);
        if (!isInside(job.destination, original)) throw new ValidationError('Chemin relatif non sûr');
        await ensureDestinationDirectory(destinationRoot, path.dirname(original), !progress.dryRun);
        const existing = await occupantAt(original, planned);

        let target = original;
        let action: 'copy' | 'same' | 'skip' | 'rename' | 'overwrite' = 'copy';
        // Never delete an apparently identical source on the strength of size alone.
        const comparison = job.operation === 'move' ? 'sha256' : job.compareMode;

        if (existing) {
          if (await sameFile(task, existing, comparison, signal, gate)) {
            action = 'same';
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
              if (await sameFile(task, occupant, comparison, signal, gate)) {
                target = candidate;
                action = 'same';
                found = true;
                break;
              }
            }
            if (!found) throw new Error('Trop de variantes de noms de fichiers');
          }
        }

        if (action === 'skip' || action === 'same') {
          progress.skipped++;
          meter?.skip(task.size);
          accountedForTask = true;
          // Identical destination: moving removes only the verified duplicate.
          // Conflict-policy skips always leave their source untouched.
          if (action === 'same' && job.operation === 'move') {
            if (!progress.dryRun) await removeMovedSource(task, target, job.destination, signal, gate);
            progress.moved = (progress.moved ?? 0) + 1;
          }
        } else {
          await ensureDestinationDirectory(destinationRoot, path.dirname(target), !progress.dryRun);
          if (!progress.dryRun) {
            meter?.beginFile(task.size);
            await copyAtomic(task, target, action === 'overwrite', signal, gate,
              bytes => meter?.chunk(bytes), mode => { progress.writeMode = mode; onUpdate(); });
            progress.bytesCopied += task.size;
            meter?.completeFile();
          } else {
            planned.set(target, task);
          }
          accountedForTask = true;
          progress.copied++;
          if (action === 'rename') progress.renamed++;
          if (action === 'overwrite') progress.overwritten++;
          if (job.operation === 'move') {
            if (!progress.dryRun) await removeMovedSource(task, target, job.destination, signal, gate);
            progress.moved = (progress.moved ?? 0) + 1;
          }
        }
      } catch (error) {
        if (!accountedForTask) meter?.fail(task.size);
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
    meter?.finish();
    progress.phase = 'finished';
    progress.currentFile = null;
    progress.currentFileBytes = 0;
    progress.currentFileSize = null;
    progress.transferEtaSeconds = null;
    progress.finishedAt = new Date().toISOString();
    onUpdate();
  }
}
