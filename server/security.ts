import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Roots, SyncJob } from './models.js';

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function mustBeAbsolute(input: string): void {
  if (!input || !path.isAbsolute(input) || input.includes('\0')) {
    throw new ValidationError('Le chemin doit être absolu.');
  }
}

export function getRoots(): Roots {
  const parse = (value: string | undefined, fallback: string): string[] =>
    (value ?? fallback).split(';').map(x => x.trim()).filter(Boolean).map(x => path.resolve(x));
  return {
    sources: parse(process.env.SYNC_SOURCE_ROOTS, '/volume1/OneDrive'),
    destinations: parse(process.env.SYNC_DEST_ROOTS, '/volumeUSB1/usbshare')
  };
}

async function ensureWithinRoot(input: string, roots: string[], existing: boolean): Promise<string> {
  mustBeAbsolute(input);
  const normalized = path.resolve(input);
  for (const root of roots) {
    if (!isInside(root, normalized)) continue;
    try {
      const realRoot = await realpath(root);
      if (existing) {
        const actual = await realpath(normalized);
        const info = await stat(normalized);
        if (!info.isDirectory() || !isInside(realRoot, actual)) continue;
      } else {
        let ancestor = normalized;
        while (true) {
          try {
            const actual = await realpath(ancestor);
            if (!isInside(realRoot, actual)) throw new ValidationError('Chemin hors de la racine autorisée.');
            break;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            const parent = path.dirname(ancestor);
            if (parent === ancestor) throw new ValidationError('Chemin inaccessible');
            ancestor = parent;
          }
        }
      }
      return root;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new ValidationError('Chemin absent ou hors des racines autorisées : ' + normalized);
}

export async function validateJobPaths(job: Pick<SyncJob, 'sources' | 'destination'>, roots: Roots): Promise<void> {
  if (!Array.isArray(job.sources) || job.sources.length < 1 || job.sources.length > 30) {
    throw new ValidationError('Il faut entre 1 et 30 dossiers sources.');
  }
  mustBeAbsolute(job.destination);
  if (new Set(job.sources.map(x => path.resolve(x))).size !== job.sources.length) {
    throw new ValidationError('Les dossiers sources ne doivent pas être dupliqués.');
  }
  for (const source of job.sources) {
    await ensureWithinRoot(source, roots.sources, true);
    if (isInside(source, job.destination) || isInside(job.destination, source)) {
      throw new ValidationError('Une source et sa destination ne peuvent pas être imbriquées.');
    }
  }
  await ensureWithinRoot(job.destination, roots.destinations, false);
}

// Ensure no destination path component is a symlink, including directories created during the run.
export async function ensureDestinationDirectory(root: string, directory: string, create: boolean): Promise<void> {
  if (!isInside(root, directory)) throw new ValidationError('Destination hors racine.');
  let cursor = path.resolve(root);
  const components = path.relative(cursor, directory).split(path.sep).filter(Boolean);
  for (const component of ['', ...components]) {
    if (component) cursor = path.join(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new ValidationError('Dossier destination non sûr : ' + cursor);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (create) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(cursor);
      }
    }
  }
}

export async function destinationRootFor(directory: string, roots: Roots): Promise<string> {
  return ensureWithinRoot(directory, roots.destinations, false);
}

export async function browseDirectories(roots: string[], requested?: string): Promise<{ path: string; name: string }[]> {
  const { readdir } = await import('node:fs/promises');
  if (!requested) return roots.map(root => ({ path: root, name: root }));
  await ensureWithinRoot(requested, roots, true);
  const entries = await readdir(requested, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => ({ path: path.join(requested, entry.name), name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
