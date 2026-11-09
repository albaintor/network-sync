import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, opendir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Roots, RunProgress, SyncJob } from './models.js';
import { isInside, sourceRootFor, ValidationError } from './security.js';
import { PauseGate } from './pause.js';

export interface DuplicateFile {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}
export interface DuplicateGroup {
  id: string;
  size: number;
  sha256: string;
  files: DuplicateFile[];
}
export interface DuplicateScan {
  scanId: string;
  directory: string;
  groups: DuplicateGroup[];
  createdAt: string;
  /** Partial scans with unreadable or changing files are view-only. */
  readOnly: boolean;
}
export interface DuplicateSelection {
  groupId: string;
  keep: string;
}
export interface DuplicateDeleteResult {
  deleted: number;
  freedBytes: number;
  errors: string[];
}

const MAX_FILES = 200_000;

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Analyse annulée.');
}

async function* walk(directory: string, signal: AbortSignal, gate: PauseGate): AsyncGenerator<string> {
  await gate.wait(signal);
  checkAbort(signal);
  const handle = await opendir(directory);
  for await (const entry of handle) {
    await gate.wait(signal);
    checkAbort(signal);
    if (entry.isSymbolicLink()) continue;
    if (entry.name === '@eaDir' || entry.name === '#recycle') continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(filename, signal, gate);
    else if (entry.isFile()) yield filename;
  }
}

async function hashFile(filename: string, signal: AbortSignal, gate: PauseGate): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename, { signal })) {
    await gate.wait(signal);
    checkAbort(signal);
    digest.update(chunk as Buffer);
  }
  return digest.digest('hex');
}

function sameIdentity(file: DuplicateFile, value: DuplicateFile): boolean {
  return file.size === value.size && file.mtimeMs === value.mtimeMs && file.ctimeMs === value.ctimeMs &&
    file.dev === value.dev && file.ino === value.ino && file.nlink === value.nlink;
}

function recordError(progress: RunProgress, file: string, error: unknown): void {
  progress.errors++;
  if (progress.errorMessages.length < 25) {
    progress.errorMessages.push(file + ' : ' + (error instanceof Error ? error.message : String(error)));
  }
}

async function verifyFile(file: DuplicateFile, directory: string, canonicalRoot: string): Promise<void> {
  if (!isInside(directory, file.path)) throw new ValidationError('Chemin hors du dossier analysé.');
  const actual = await realpath(file.path);
  if (!isInside(canonicalRoot, actual)) throw new ValidationError('Chemin réel hors du dossier analysé.');
  const stat = await lstat(file.path);
  if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(file, {
    path: file.path, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino, nlink: stat.nlink
  })) {
    throw new ValidationError('Fichier modifié depuis le scan : ' + file.path);
  }
}

/**
 * Discover duplicates recursively: index by size first, then hash only files
 * whose size occurs more than once. Names are deliberately not compared.
 * Scanning itself never alters the source tree.
 */
export async function scanDuplicates(
  job: SyncJob, progress: RunProgress, roots: Roots, signal: AbortSignal,
  onUpdate: () => void = () => {}, gate: PauseGate = new PauseGate()
): Promise<DuplicateScan | null> {
  const directory = job.sources[0];
  try {
    if (job.sources.length !== 1) throw new ValidationError('La recherche nécessite un seul dossier.');
    await sourceRootFor(directory, roots);
    const canonicalRoot = await realpath(directory);
    const bySize = new Map<number, DuplicateFile[]>();
    for await (const filename of walk(directory, signal, gate)) {
      checkAbort(signal);
      progress.filesTotal++;
      if (progress.filesTotal > MAX_FILES) throw new ValidationError('Limite de 200 000 fichiers atteinte. Choisissez un dossier plus restreint.');
      try {
        const info = await lstat(filename);
        // Files with multiple hard links do not release their blocks when only one link is removed.
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) continue;
        const file: DuplicateFile = {
          path: filename, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino, nlink: info.nlink
        };
        const entries = bySize.get(info.size) ?? [];
        entries.push(file);
        bySize.set(info.size, entries);
      } catch (error) { recordError(progress, filename, error); }
      if (progress.filesTotal % 200 === 0) onUpdate();
    }
    const candidates = [...bySize.values()].filter(files => files.length > 1).flat();
    progress.phase = 'hashing';
    progress.candidateFiles = candidates.length;
    progress.processed = 0;
    onUpdate();

    const byHash = new Map<string, DuplicateFile[]>();
    for (const file of candidates) {
      await gate.wait(signal);
      checkAbort(signal);
      progress.currentFile = file.path;
      try {
        await verifyFile(file, directory, canonicalRoot);
        const hash = await hashFile(file.path, signal, gate);
        await verifyFile(file, directory, canonicalRoot);
        const key = file.size + ':' + hash;
        const items = byHash.get(key) ?? [];
        items.push(file);
        byHash.set(key, items);
      } catch (error) {
        if (signal.aborted) throw error;
        recordError(progress, file.path, error);
      }
      progress.processed++;
      onUpdate();
    }
    const groups: DuplicateGroup[] = [];
    for (const [key, files] of byHash) {
      // Hard links do not occupy extra space; avoid proposing their deletion.
      const unique = new Map<string, DuplicateFile>();
      for (const file of files) unique.set(file.dev + ':' + file.ino, file);
      if (unique.size < 2) continue;
      const distinct = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path, 'fr'));
      groups.push({ id: randomUUID(), size: distinct[0].size, sha256: key.slice(key.indexOf(':') + 1), files: distinct });
    }
    groups.sort((a, b) => (b.files.length - 1) * b.size - (a.files.length - 1) * a.size || a.id.localeCompare(b.id));
    progress.duplicateGroups = groups.length;
    progress.status = progress.errors ? 'completed_with_errors' : 'completed';
    return { scanId: randomUUID(), directory, groups, createdAt: new Date().toISOString(), readOnly: progress.errors > 0 };
  } catch (error) {
    if (signal.aborted) progress.status = 'cancelled';
    else {
      recordError(progress, directory, error);
      progress.status = 'failed';
    }
    return null;
  } finally {
    progress.phase = 'finished';
    progress.currentFile = null;
    progress.finishedAt = new Date().toISOString();
    onUpdate();
  }
}

/**
 * Only accept keepers and groups selected from one server-side scan. All
 * members of each selected group, including the keeper, are checked again
 * against their recorded identity AND original SHA-256 before deleting any.
 * One bad member prevents deletion of that group.
 */
export async function deleteDuplicates(
  scan: DuplicateScan, selections: DuplicateSelection[], roots: Roots
): Promise<DuplicateDeleteResult> {
  if (scan.readOnly) throw new ValidationError('Analyse incomplète : relancer la recherche avant suppression.');
  if (!Array.isArray(selections) || !selections.length || selections.length > scan.groups.length) {
    throw new ValidationError('Sélection de groupes invalide.');
  }
  await sourceRootFor(scan.directory, roots);
  const canonicalRoot = await realpath(scan.directory);
  const groupsById = new Map(scan.groups.map(group => [group.id, group]));
  const ids = new Set<string>();
  const result: DuplicateDeleteResult = { deleted: 0, freedBytes: 0, errors: [] };
  for (const choice of selections) {
    if (!choice || typeof choice.groupId !== 'string' || typeof choice.keep !== 'string' ||
        ids.has(choice.groupId)) throw new ValidationError('Sélection répétée ou invalide.');
    ids.add(choice.groupId);
    const group = groupsById.get(choice.groupId);
    if (!group || !group.files.some(file => file.path === choice.keep)) {
      throw new ValidationError('Groupe ou fichier à conserver inconnu : relancer l’analyse.');
    }
  }
  for (const choice of selections) {
    const group = groupsById.get(choice.groupId)!;
    try {
      // Verify every candidate *before* the first deletion.
      for (const file of group.files) {
        await verifyFile(file, scan.directory, canonicalRoot);
        if (await hashFile(file.path, new AbortController().signal, new PauseGate()) !== group.sha256) {
          throw new ValidationError('Le contenu a changé depuis le scan : ' + file.path);
        }
        await verifyFile(file, scan.directory, canonicalRoot);
      }
      const keeper = group.files.find(file => file.path === choice.keep)!;
      for (const file of group.files) {
        if (file.path === choice.keep) continue;
        // Recheck the keeper and victim immediately before each unlink.
        await verifyFile(keeper, scan.directory, canonicalRoot);
        await verifyFile(file, scan.directory, canonicalRoot);
        await unlink(file.path);
        result.deleted++;
        result.freedBytes += file.size;
      }
    } catch (error) {
      result.errors.push('Groupe ' + group.id + ' : ' +
        (error instanceof Error ? error.message : String(error)));
    }
  }
  return result;
}
